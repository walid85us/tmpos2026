#!/usr/bin/env node
// Phase 4.0 M2 — lockfile portability checker (gate, permanent).
//
// A lockfile generated behind an environment-internal registry mirror is not portable:
// its `resolved` URLs name a host that does not exist outside that environment. The
// failure is silent, not loud — npm marks some packages `devOptional`, and a devOptional
// package whose tarball cannot be fetched is SKIPPED, leaving `npm ci` to exit 0 with the
// package absent. That is how a green install shipped without @types/react.
//
// Because the failure survives `npm ci`, this gate must run BEFORE installation. It
// therefore uses only Node built-ins and never requires node_modules to exist.
//
// Enforcement is an exact-host allowlist. The dangerous classes below are still detected
// separately: it keeps a failure diagnosable without printing URLs, and it means widening
// the allowlist can never silently admit a loopback or metadata-service host.
//
// It resolves the repository from THIS FILE's location, never the caller's cwd.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/** Exact hosts permitted for registry tarballs. Suffix matching is never used. */
export const APPROVED_REGISTRY_HOSTS = new Set(['registry.npmjs.org']);

/** Hostname suffixes that only resolve inside a private network. */
const INTERNAL_TLDS = ['.local', '.internal'];

/**
 * Resolution schemes that are not registry tarballs. The committed tree contains none
 * (0 file:/git:/workspace:/link: resolutions), so they fail closed rather than being
 * pre-authorised: adding one must trip this gate and require an exact, tested rule.
 */
const NON_REGISTRY_SCHEMES = new Set(['file', 'git', 'git+ssh', 'git+https', 'git+http', 'workspace', 'link', 'portal']);

const octets = (h) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
};

/**
 * Classify a hostname into a dangerous class, or null when it is an ordinary public name.
 * Expects a WHATWG-normalized hostname (as `new URL().hostname` produces): IPv4 is already
 * canonical dotted-decimal and IDNs are already punycode. Callers passing raw user input
 * must normalize first.
 */
export function classifyHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback_host';
  if (h === '::1') return 'loopback_host';
  // WHATWG re-encodes an IPv4-mapped IPv6 address to hex (::ffff:169.254.169.254 becomes
  // ::ffff:a9fe:a9fe), which matches none of the rules below. Unpack the embedded IPv4 and
  // classify that, or a mapped loopback/metadata address reads as an ordinary host.
  const mapped = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d{1,3}(?:\.\d{1,3}){3}))$/.exec(h);
  if (mapped) {
    if (mapped[3]) return classifyHost(mapped[3]);
    const n = ((parseInt(mapped[1], 16) << 16) >>> 0) + parseInt(mapped[2], 16);
    return classifyHost([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  if (/^fe[89ab]/.test(h) && h.includes(':')) return 'link_local_host'; // fe80::/10
  if (/^f[cd]/.test(h) && h.includes(':')) return 'private_host'; // fc00::/7 unique-local
  const ip = octets(h);
  if (ip) {
    const [a, b] = ip;
    if (a === 127 || a === 0) return 'loopback_host';
    if (a === 169 && b === 254) return 'link_local_host'; // includes the 169.254.169.254 metadata service
    if (a === 10) return 'private_host';
    if (a === 172 && b >= 16 && b <= 31) return 'private_host';
    if (a === 192 && b === 168) return 'private_host';
  }
  if (INTERNAL_TLDS.some((t) => h.endsWith(t))) return 'internal_tld_host';
  return null;
}

/**
 * Classify one `resolved` value.
 * Returns { ok, reason, host } — reason is null only when ok.
 */
export function classifyResolved(resolved) {
  if (typeof resolved !== 'string' || resolved === '') return { ok: false, reason: 'malformed_url', host: null };

  const scheme = /^([a-z0-9+.-]+):/i.exec(resolved)?.[1]?.toLowerCase();
  if (scheme && NON_REGISTRY_SCHEMES.has(scheme)) return { ok: false, reason: 'unsupported_scheme', host: null };

  let u;
  try {
    u = new URL(resolved);
  } catch {
    return { ok: false, reason: 'malformed_url', host: null };
  }
  if (!u.hostname) return { ok: false, reason: 'malformed_url', host: null };

  // Credentials outrank every other verdict: the URL must be reported as leaking, not
  // merely as pointing somewhere unapproved.
  if (u.username || u.password) return { ok: false, reason: 'embedded_credentials', host: null };

  const dangerous = classifyHost(u.hostname);
  if (dangerous) return { ok: false, reason: dangerous, host: u.hostname };

  if (u.protocol !== 'https:') return { ok: false, reason: 'insecure_scheme', host: u.hostname };
  if (!APPROVED_REGISTRY_HOSTS.has(u.hostname.toLowerCase())) return { ok: false, reason: 'unapproved_host', host: u.hostname };
  // The registry serves on the default HTTPS port; anything else on this host is some
  // other service, so it is not the registry we approved.
  if (u.port !== '') return { ok: false, reason: 'non_default_port', host: u.hostname };

  return { ok: true, reason: null, host: u.hostname };
}

/** The enclosing package entry key for a nested path, or null at the top level. */
export function parentPackageKey(key) {
  const i = key.lastIndexOf('/node_modules/');
  return i === -1 ? null : key.slice(0, i);
}

/** The package name a nested entry key denotes (`node_modules/a/node_modules/@s/b` -> `@s/b`). */
export function packageNameOf(key) {
  const i = key.lastIndexOf('node_modules/');
  return i === -1 ? null : key.slice(i + 'node_modules/'.length);
}

const parseVersion = (v) => {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(v ?? ''));
  return m ? m.slice(1).map(Number) : null;
};

/**
 * Whether `version` satisfies `spec`, for the exact / caret / tilde forms.
 * Returns null when the form is not one this gate decides — the caller must then fail
 * closed rather than assume a pass. Deliberately not a general semver implementation: a
 * half-correct range engine in a security gate is worse than an honest "cannot decide".
 */
export function satisfiesSpec(version, spec) {
  const v = parseVersion(version);
  if (!v || typeof spec !== 'string') return null;
  const m = /^([\^~]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(spec.trim());
  if (!m) return null;
  const [, op, ...parts] = m;
  const s = parts.map(Number);
  const gte = v[0] > s[0] || (v[0] === s[0] && (v[1] > s[1] || (v[1] === s[1] && v[2] >= s[2])));
  if (op === '') return v[0] === s[0] && v[1] === s[1] && v[2] === s[2];
  if (!gte) return false;
  // Caret pins the leftmost non-zero component: ^1.2.3 -> <2.0.0, ^0.10.1 -> <0.11.0,
  // ^0.0.3 -> <0.0.4. Tilde always pins the minor.
  if (op === '~') return v[0] === s[0] && v[1] === s[1];
  if (s[0] !== 0) return v[0] === s[0];
  if (s[1] !== 0) return v[0] === 0 && v[1] === s[1];
  return v[0] === 0 && v[1] === 0 && v[2] === s[2];
};

/**
 * Validate a bundled entry against the parent whose tarball actually carries its bytes.
 * Returns a reason string, or null when the entry is sound.
 */
export function checkBundledEntry(key, packages) {
  const parentKey = parentPackageKey(key);
  const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const parent = parentKey !== null ? own(packages, parentKey) : undefined;
  // The parent must exist and be a tarball this gate already approves, or the child's
  // content is not covered by anything verified.
  if (!parent || !classifyResolved(parent.resolved).ok || !parent.integrity) return 'orphan_bundled_entry';

  const name = packageNameOf(key);
  const bundled = Array.isArray(parent.bundleDependencies) ? parent.bundleDependencies : [];
  if (!bundled.includes(name)) return 'bundled_entry_not_declared_by_parent';

  const spec = own(parent.dependencies, name)
    ?? own(parent.optionalDependencies, name)
    ?? own(parent.peerDependencies, name);
  if (spec === undefined) return 'bundled_entry_not_declared_by_parent';

  const sat = satisfiesSpec((own(packages, key) || {}).version, spec);
  if (sat === null) return 'bundled_entry_unverifiable_spec';
  if (sat === false) return 'bundled_entry_version_mismatch';
  return null;
}


/** Keys come from the artifact under review, so they are never echoed raw. */
const safeKey = (k) => String(k).replace(/[^\w@/.\-]/g, '?').slice(0, 120) || '(root)';

/**
 * The canonical registry tarball path this entry must resolve to, or null when the entry
 * carries too little to say. `e.name` is honoured so npm aliases (`string-width-cjs` whose
 * entry declares name `string-width`) bind to their target rather than their key.
 */
export function expectedTarballPath(key, entry) {
  const name = entry.name ?? packageNameOf(key);
  if (!name || !entry.version) return null;
  const base = name.slice(name.lastIndexOf('/') + 1);
  return `/${name}/-/${base}-${entry.version}.tgz`;
}

/** Inspect a parsed lockfile object. Never throws for the expected failures. */
export function inspectLockfile(lock) {
  const problems = [];
  const packages = lock?.packages;
  // `typeof [] === 'object'` and an array is truthy, so an array would pass a plain object
  // check, yield no entries, and report ok — a truncated or emptied lockfile must fail closed.
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    return { ok: false, problems: ['lockfile has no usable `packages` map — unsupported lockfile version'], summary: null };
  }
  if (!Object.prototype.hasOwnProperty.call(packages, '')) {
    problems.push('lockfile has no root ("") entry — not a complete npm lockfile');
  }

  const counts = {
    totalEntries: 0,
    withResolved: 0,
    approved: 0,
    nonHttps: 0,
    internalHosts: 0,
    loopbackHosts: 0,
    privateHosts: 0,
    linkLocalHosts: 0,
    unapprovedHosts: 0,
    embeddedCredentials: 0,
    malformedUrls: 0,
    unsupportedSchemes: 0,
    nonDefaultPort: 0,
    missingIntegrity: 0,
    pathMismatch: 0,
    bundledEntries: 0,
    bundledProblems: 0,
  };

  for (const [key, entry] of Object.entries(packages)) {
    counts.totalEntries++;
    const e = entry || {};

    // Two entry kinds legitimately resolve to no tarball of their own: the root project,
    // and bundleDependencies, which ship inside the parent's tarball. (Workspace links are
    // NOT among them — npm gives those a relative-path `resolved`, so they fall through to
    // classifyResolved and fail closed. This tree has none; per the gate's contract a real
    // one must trip it and get an exact, tested rule rather than a blanket path allowance.)
    if (e.resolved === undefined) {
      if (key === '') continue;
      if (e.inBundle === true) {
        // `inBundle` is self-declared by the very file under review, so it cannot be taken
        // on trust: skipping on the flag alone would let any entry opt out of validation.
        // Requiring an approved, integrity-bearing parent that declares this name+version
        // reduces one self-declared flag to a coherent set of parent metadata — hardening
        // against corruption, NOT a trust anchor against a hostile author (that would need
        // the parent tarball's own package.json). The escape it prevents yields absence,
        // never substitution: with no resolved/integrity there is nothing to fetch.
        const reason = checkBundledEntry(key, packages);
        if (reason === null) { counts.bundledEntries++; continue; }
        counts.bundledProblems++;
        problems.push(`${safeKey(key)}: ${reason}`);
        continue;
      }
      problems.push(`${safeKey(key)}: missing_resolved`);
      continue;
    }
    counts.withResolved++;

    const c = classifyResolved(e.resolved);

    // Diagnostic counters are independent of the single verdict, so an internal host that
    // is also plain HTTP is counted in both — the report must not under-state either.
    if (typeof e.resolved === 'string') {
      try {
        const u = new URL(e.resolved);
        if (u.protocol !== 'https:') counts.nonHttps++;
        const d = classifyHost(u.hostname);
        if (d === 'internal_tld_host') counts.internalHosts++;
        if (d === 'loopback_host') counts.loopbackHosts++;
        if (d === 'private_host') counts.privateHosts++;
        if (d === 'link_local_host') counts.linkLocalHosts++;
        if (!APPROVED_REGISTRY_HOSTS.has(u.hostname.toLowerCase())) counts.unapprovedHosts++;
      } catch { /* counted below via the verdict */ }
    }

    if (!c.ok) {
      if (c.reason === 'embedded_credentials') counts.embeddedCredentials++;
      if (c.reason === 'malformed_url') counts.malformedUrls++;
      if (c.reason === 'unsupported_scheme') counts.unsupportedSchemes++;
      if (c.reason === 'non_default_port') counts.nonDefaultPort++;
      problems.push(`${safeKey(key)}: ${c.reason}`);
      continue;
    }

    counts.approved++;
    // An approved tarball without integrity is unverifiable: npm would fetch whatever the
    // registry returns for that URL with nothing to check it against.
    if (!e.integrity) {
      counts.missingIntegrity++;
      problems.push(`${safeKey(key)}: missing_integrity`);
    }
    // Right host, wrong package is still wrong. Nothing above ties the tarball path to the
    // entry it sits under, and an integrity failure is NOT loud for every entry: npm skips
    // an optional/devOptional package that fails to install and still exits 0 — the same
    // silent-absence that shipped a build without @types/react (itself devOptional). An
    // exact path match also rejects any registry mount prefix, which is the specific shape
    // (`/npm/...`) that made this lockfile unportable in the first place.
    const expected = expectedTarballPath(key, e);
    if (expected !== null && new URL(e.resolved).pathname !== expected) {
      counts.pathMismatch++;
      problems.push(`${safeKey(key)}: resolved_does_not_match_name_version`);
    }
  }

  return { ok: problems.length === 0, problems, summary: counts };
}

/** Read and inspect `package-lock.json` under `repoRoot`. */
export function inspectLockfileAt(repoRoot = REPO_ROOT) {
  const lockPath = join(repoRoot, 'package-lock.json');
  if (!existsSync(lockPath)) return { ok: false, problems: ['package-lock.json not found'], summary: null };
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return { ok: false, problems: ['package-lock.json could not be parsed'], summary: null };
  }
  return inspectLockfile(lock);
}

/** Bounded rendering. Counts only — never a URL, host, token, or package content. */
export function formatSummary(s) {
  return [
    `approved registry   ${[...APPROVED_REGISTRY_HOSTS].join(', ')}`,
    `package entries     ${s.totalEntries}`,
    `with resolved       ${s.withResolved}`,
    `approved https      ${s.approved}`,
    `non-https           ${s.nonHttps}`,
    `internal hosts      ${s.internalHosts}`,
    `loopback/private    ${s.loopbackHosts + s.privateHosts + s.linkLocalHosts}`,
    `unapproved hosts    ${s.unapprovedHosts}`,
    `embedded creds      ${s.embeddedCredentials}`,
    `malformed urls      ${s.malformedUrls}`,
    `unsupported schemes ${s.unsupportedSchemes}`,
    `non-default port    ${s.nonDefaultPort}`,
    `missing integrity   ${s.missingIntegrity}`,
    `path mismatch       ${s.pathMismatch}`,
    `bundled (in parent) ${s.bundledEntries}`,
  ].join('\n');
}

const MAX_LISTED = 10;

export function runPortabilityCheck(repoRoot = REPO_ROOT) {
  const { ok, problems, summary } = inspectLockfileAt(repoRoot);
  if (summary) console.log(formatSummary(summary));
  for (const p of problems.slice(0, MAX_LISTED)) console.error(`lockfile-portability: ${p}`);
  if (problems.length > MAX_LISTED) {
    console.error(`lockfile-portability: ... and ${problems.length - MAX_LISTED} more`);
  }
  if (!ok) {
    console.error(`lockfile-portability: FAILED — ${problems.length} unportable entr${problems.length === 1 ? 'y' : 'ies'}`);
    console.error('lockfile-portability: regenerate the lock against the public registry from a clean environment.');
    return 1;
  }
  console.log('lockfile-portability: OK');
  return 0;
}

// Node realpaths ESM modules, so `import.meta.url` is the resolved path while
// `process.argv[1]` is literal. Under a symlinked checkout (e.g. macOS /var -> /private/var)
// they differ, the block would never run, and the gate would exit 0 having checked nothing.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exit(runPortabilityCheck());
}
