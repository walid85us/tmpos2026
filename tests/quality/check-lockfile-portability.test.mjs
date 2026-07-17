// Phase 4.0 M2 — tests for the lockfile portability checker.
//
// The committed lockfile was generated behind an environment-internal registry mirror,
// so 688 of its resolved URLs pointed at a host that only exists inside this workspace.
// npm marks some packages `devOptional`, and a devOptional package whose tarball cannot
// be fetched is SKIPPED SILENTLY — `npm ci` still exits 0. That is how a green install
// shipped without @types/react, and why this gate must run BEFORE npm ci rather than
// trusting its exit code.
//
// The rules are asserted one class per test: the enforcement is an exact-host allowlist,
// but each dangerous class is classified separately so a failure is diagnosable and so
// widening the allowlist later cannot silently admit a loopback or metadata-service host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  REPO_ROOT,
  APPROVED_REGISTRY_HOSTS,
  classifyResolved,
  classifyHost,
  parentPackageKey,
  packageNameOf,
  expectedTarballPath,
  satisfiesSpec,
  inspectLockfile,
  inspectLockfileAt,
  formatSummary,
} from '../../scripts/check-lockfile-portability.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CHECKER = join(REPO, 'scripts', 'check-lockfile-portability.mjs');
const created = [];

test.after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

/**
 * A stand-in repository holding a copy of the checker plus `lock`. The checker resolves
 * its root from its own file location, so this is the only way to exercise the CLI
 * against a lockfile other than this repository's — and it proves that design works.
 */
function makeRepoFixture(lock) {
  const dir = mkdtempSync(join(tmpdir(), 'lock-portability-'));
  created.push(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(CHECKER, join(dir, 'scripts', 'check-lockfile-portability.mjs'));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
  return join(dir, 'scripts', 'check-lockfile-portability.mjs');
}

const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '==';

/** A minimal in-memory lock: one root plus one dependency at `resolved`. */
function lockWith(resolved, extra = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/pkg': { version: '1.0.0', resolved, integrity: INTEGRITY, ...extra },
    },
  };
}

const reasonFor = (url) => classifyResolved(url).reason;

/** The canonical tarball for `lockWith`'s `node_modules/pkg` entry at 1.0.0. */
const PORTABLE_URL = 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz';

test('the approved host set is exactly the public npm registry', () => {
  assert.deepEqual([...APPROVED_REGISTRY_HOSTS], ['registry.npmjs.org']);
});

test('accepts a canonical public registry tarball', () => {
  const c = classifyResolved('https://registry.npmjs.org/react/-/react-19.2.0.tgz');
  assert.equal(c.ok, true);
  assert.equal(c.host, 'registry.npmjs.org');
});

test('rejects the environment-internal registry mirror', () => {
  assert.equal(reasonFor('http://package-firewall.replit.local/npm/react/-/react-19.2.0.tgz'), 'internal_tld_host');
});

test('rejects any .local hostname', () => {
  assert.equal(reasonFor('https://anything.local/pkg/-/pkg-1.0.0.tgz'), 'internal_tld_host');
  assert.equal(reasonFor('https://registry.internal/pkg/-/pkg-1.0.0.tgz'), 'internal_tld_host');
});

test('rejects localhost and loopback addresses', () => {
  assert.equal(reasonFor('https://localhost/pkg/-/pkg-1.0.0.tgz'), 'loopback_host');
  assert.equal(reasonFor('https://127.0.0.1:4873/pkg/-/pkg-1.0.0.tgz'), 'loopback_host');
  assert.equal(reasonFor('https://127.99.1.2/pkg/-/pkg-1.0.0.tgz'), 'loopback_host');
  assert.equal(reasonFor('https://[::1]/pkg/-/pkg-1.0.0.tgz'), 'loopback_host');
});

test('rejects RFC1918 private hosts', () => {
  assert.equal(reasonFor('https://10.0.0.1/pkg/-/pkg-1.0.0.tgz'), 'private_host');
  assert.equal(reasonFor('https://172.16.0.1/pkg/-/pkg-1.0.0.tgz'), 'private_host');
  assert.equal(reasonFor('https://172.31.255.255/pkg/-/pkg-1.0.0.tgz'), 'private_host');
  assert.equal(reasonFor('https://192.168.1.1/pkg/-/pkg-1.0.0.tgz'), 'private_host');
  assert.equal(reasonFor('https://[fd00::1]/pkg/-/pkg-1.0.0.tgz'), 'private_host');
});

test('does not misclassify public addresses adjacent to the private ranges', () => {
  // 172.32/12 and 11/8 sit just outside RFC1918; they are public and must fail only
  // on the allowlist, never be mislabelled as private.
  assert.equal(reasonFor('https://172.32.0.1/pkg/-/pkg-1.0.0.tgz'), 'unapproved_host');
  assert.equal(reasonFor('https://11.0.0.1/pkg/-/pkg-1.0.0.tgz'), 'unapproved_host');
  assert.equal(reasonFor('https://128.0.0.1/pkg/-/pkg-1.0.0.tgz'), 'unapproved_host');
});

test('rejects link-local and metadata-service addresses', () => {
  assert.equal(reasonFor('https://169.254.1.1/pkg/-/pkg-1.0.0.tgz'), 'link_local_host');
  assert.equal(reasonFor('https://169.254.169.254/pkg/-/pkg-1.0.0.tgz'), 'link_local_host');
  assert.equal(reasonFor('https://[fe80::1]/pkg/-/pkg-1.0.0.tgz'), 'link_local_host');
});

test('classifies IPv4-mapped IPv6, which WHATWG re-encodes to hex', () => {
  // new URL() turns [::ffff:169.254.169.254] into [::ffff:a9fe:a9fe]; without unpacking it,
  // the metadata service reads as an ordinary public host and only the allowlist stops it.
  assert.equal(classifyHost('[::ffff:a9fe:a9fe]'), 'link_local_host');
  assert.equal(classifyHost('[::ffff:7f00:1]'), 'loopback_host');
  assert.equal(classifyHost('[::ffff:0a00:0001]'), 'private_host');
  assert.equal(reasonFor('https://[::ffff:169.254.169.254]/pkg/-/pkg-1.0.0.tgz'), 'link_local_host');
  assert.equal(reasonFor('https://[::ffff:127.0.0.1]/pkg/-/pkg-1.0.0.tgz'), 'loopback_host');
});

test('does not mistake an ordinary hostname for an IPv6 range', () => {
  // The fc00::/7 and fe80::/10 rules match on a leading 'fc'/'fe8'; a DNS name starting
  // with those letters must stay unclassified and be judged by the allowlist alone.
  assert.equal(classifyHost('fcm.googleapis.com'), null);
  assert.equal(classifyHost('fe80.example.com'), null);
  assert.equal(classifyHost('fd-cdn.example.com'), null);
  assert.equal(reasonFor('https://fcm.googleapis.com/pkg/-/pkg-1.0.0.tgz'), 'unapproved_host');
});

test('rejects a plain HTTP URL on an otherwise approved host', () => {
  assert.equal(reasonFor('http://registry.npmjs.org/react/-/react-19.2.0.tgz'), 'insecure_scheme');
});

test('rejects an unknown external registry', () => {
  assert.equal(reasonFor('https://registry.yarnpkg.com/react/-/react-19.2.0.tgz'), 'unapproved_host');
  assert.equal(reasonFor('https://evil.example.com/react/-/react-19.2.0.tgz'), 'unapproved_host');
  // A lookalike must not pass on a suffix match.
  assert.equal(reasonFor('https://registry.npmjs.org.evil.com/x/-/x-1.0.0.tgz'), 'unapproved_host');
});

test('rejects a non-default port on the approved host', () => {
  // registry.npmjs.org:8443 is not the registry service, whatever the hostname says.
  assert.equal(reasonFor('https://registry.npmjs.org:8443/x/-/x-1.0.0.tgz'), 'non_default_port');
  assert.equal(classifyResolved('https://registry.npmjs.org:443/x/-/x-1.0.0.tgz').ok, true, 'explicit :443 is the default port');
});

test('rejects hosts that only look like the approved registry', () => {
  // `registry.npmjs.org@evil.com` parses to host evil.com — the classic userinfo
  // confusion. It must be caught, not read as the approved host.
  assert.equal(reasonFor('https://registry.npmjs.org@evil.com/x/-/x-1.0.0.tgz'), 'embedded_credentials');
  assert.equal(reasonFor('https://registry.npmjs.org./x/-/x-1.0.0.tgz'), 'unapproved_host');
  assert.equal(reasonFor('https://xn--registry-6l7b.npmjs.org/x/-/x-1.0.0.tgz'), 'unapproved_host');
  assert.equal(classifyResolved('https://REGISTRY.NPMJS.ORG/x/-/x-1.0.0.tgz').ok, true, 'case is not significant in a hostname');
});

test('rejects obfuscated encodings of a loopback address', () => {
  // WHATWG normalises these to 127.0.0.1; assert it rather than assume it.
  assert.equal(reasonFor('http://2130706433/x/-/x-1.0.0.tgz'), 'loopback_host');
  assert.equal(reasonFor('http://0x7f.0.0.1/x/-/x-1.0.0.tgz'), 'loopback_host');
  assert.equal(reasonFor('http://127.1/x/-/x-1.0.0.tgz'), 'loopback_host');
});

test('rejects credentials embedded in a URL ahead of any host verdict', () => {
  assert.equal(reasonFor('https://user:tok@registry.npmjs.org/x/-/x-1.0.0.tgz'), 'embedded_credentials');
  assert.equal(reasonFor('https://tok@registry.npmjs.org/x/-/x-1.0.0.tgz'), 'embedded_credentials');
});

test('rejects malformed resolved URLs', () => {
  assert.equal(reasonFor('not-a-url'), 'malformed_url');
  assert.equal(reasonFor('https://'), 'malformed_url');
  assert.equal(reasonFor(''), 'malformed_url');
});

test('rejects non-registry resolution schemes (none exist; fail closed)', () => {
  assert.equal(reasonFor('file:../local-pkg'), 'unsupported_scheme');
  assert.equal(reasonFor('git+ssh://git@github.com/o/r.git#abc'), 'unsupported_scheme');
  assert.equal(reasonFor('workspace:packages/x'), 'unsupported_scheme');
});

test('rejects an entry whose resolved path names a different package', () => {
  // Right host, right shape, wrong package. This matters because npm SKIPS an optional or
  // devOptional package that fails to install (integrity failure included) and still exits
  // 0 — @types/react is itself devOptional, so "npm ci would catch it" is not true here.
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/@types/react': {
        version: '19.2.17',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: INTEGRITY,
        devOptional: true,
      },
    },
  };
  const { ok, problems, summary } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('resolved_does_not_match_name_version')), problems.join('; '));
  assert.equal(summary.pathMismatch, 1);
});

test('rejects an entry whose resolved path names a different version', () => {
  const lock = lockWith('https://registry.npmjs.org/pkg/-/pkg-9.9.9.tgz');
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false, 'entry is version 1.0.0 but the tarball is 9.9.9');
  assert.ok(problems.some((p) => p.includes('resolved_does_not_match_name_version')));
});

test('rejects a registry mount prefix on the tarball path', () => {
  // The original defect's exact shape: the mirror served packages under /npm/. Even on the
  // approved host, a mount prefix means the path is not the canonical tarball path.
  const lock = lockWith('https://registry.npmjs.org/npm/pkg/-/pkg-1.0.0.tgz');
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('resolved_does_not_match_name_version')), problems.join('; '));
});

test('binds an npm alias to its target rather than its key', () => {
  // `string-width-cjs` is an alias whose entry declares name `string-width`; its tarball
  // legitimately does not match its key. Using the key would be a false positive.
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/string-width-cjs': {
        name: 'string-width',
        version: '4.2.3',
        resolved: 'https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz',
        integrity: INTEGRITY,
      },
      'node_modules/@types/react': {
        version: '19.2.17',
        resolved: 'https://registry.npmjs.org/@types/react/-/react-19.2.17.tgz',
        integrity: INTEGRITY,
      },
    },
  };
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(problems.length, 0, problems.join('; '));
  assert.equal(ok, true);
});

test('expectedTarballPath handles scopes, aliases and missing fields', () => {
  assert.equal(expectedTarballPath('node_modules/@types/react', { version: '19.2.17' }), '/@types/react/-/react-19.2.17.tgz');
  assert.equal(expectedTarballPath('node_modules/tslib', { version: '2.8.1' }), '/tslib/-/tslib-2.8.1.tgz');
  assert.equal(expectedTarballPath('node_modules/a/node_modules/b', { version: '1.0.0' }), '/b/-/b-1.0.0.tgz');
  assert.equal(expectedTarballPath('node_modules/string-width-cjs', { name: 'string-width', version: '4.2.3' }), '/string-width/-/string-width-4.2.3.tgz');
  // Too little to decide -> null, so the caller does not invent an expectation.
  assert.equal(expectedTarballPath('node_modules/x', {}), null);
  assert.equal(expectedTarballPath('', { version: '1.0.0' }), null);
});

test('rejects a registry entry missing its integrity value', () => {
  const lock = lockWith('https://registry.npmjs.org/x/-/x-1.0.0.tgz', { integrity: undefined });
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('missing_integrity')));
});

test('a fully portable lockfile passes', () => {
  const { ok, problems, summary } = inspectLockfile(lockWith(PORTABLE_URL));
  assert.equal(problems.length, 0, problems.join('; '));
  assert.equal(ok, true);
  assert.equal(summary.internalHosts, 0);
  assert.equal(summary.nonHttps, 0);
  assert.equal(summary.unapprovedHosts, 0);
  assert.equal(summary.approved, 1);
});

test('inspects every nested package entry, not just the top level', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: INTEGRITY },
      'node_modules/a/node_modules/b': {
        version: '2.0.0',
        resolved: 'http://package-firewall.replit.local/npm/b/-/b-2.0.0.tgz',
        integrity: INTEGRITY,
      },
    },
  };
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('node_modules/a/node_modules/b')), 'nested entry must be reported');
});

test('a devOptional entry is inspected exactly like a required one', () => {
  // npm silently SKIPS an unfetchable devOptional package and still exits 0 — the exact
  // failure that shipped a green install without @types/react. It must not be exempt.
  const lock = lockWith('http://package-firewall.replit.local/npm/x/-/x-1.0.0.tgz', { devOptional: true });
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('internal_tld_host')));
});

/** A parent tarball that legitimately bundles `bundled` at the given spec. */
function lockWithBundled({ spec = '^2.0.0', version = '2.0.0', declare = true, bundleList = true } = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/parent': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz',
        integrity: INTEGRITY,
        bundleDependencies: bundleList ? ['bundled'] : [],
        ...(declare ? { dependencies: { bundled: spec } } : {}),
      },
      'node_modules/parent/node_modules/bundled': { version, inBundle: true, optional: true },
    },
  };
}

test('accepts bundleDependencies, which carry no resolved or integrity of their own', () => {
  // A bundled dep ships inside its parent's tarball, so it has neither field; the parent's
  // integrity covers its content. Demanding `resolved` here would fail closed on a correct
  // lockfile — the public registry resolves 6 such entries under @tailwindcss/oxide-wasm32-wasi.
  const { ok, problems, summary } = inspectLockfile(lockWithBundled());
  assert.equal(problems.length, 0, problems.join('; '));
  assert.equal(ok, true);
  assert.equal(summary.bundledEntries, 1);
});

test('rejects a bundled entry whose version does not satisfy the parent declaration', () => {
  const { ok, problems } = inspectLockfile(lockWithBundled({ spec: '^2.0.0', version: '3.0.0' }));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('bundled_entry_version_mismatch')), problems.join('; '));
});

test('rejects a bundled entry the parent never declares', () => {
  const undeclared = inspectLockfile(lockWithBundled({ declare: false }));
  assert.equal(undeclared.ok, false);
  assert.ok(undeclared.problems.some((p) => p.includes('bundled_entry_not_declared_by_parent')));

  const notBundled = inspectLockfile(lockWithBundled({ bundleList: false }));
  assert.equal(notBundled.ok, false);
  assert.ok(notBundled.problems.some((p) => p.includes('bundled_entry_not_declared_by_parent')));
});

test('fails closed on a bundled spec form it cannot decide', () => {
  // A half-correct range engine in a gate is worse than an honest refusal to decide.
  const { ok, problems } = inspectLockfile(lockWithBundled({ spec: '>=1.0.0 <3.0.0 || 4.x' }));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('bundled_entry_unverifiable_spec')), problems.join('; '));
});

test('satisfiesSpec decides exact, caret and tilde, and refuses anything else', () => {
  assert.equal(satisfiesSpec('1.8.1', '^1.8.1'), true);
  assert.equal(satisfiesSpec('1.9.0', '^1.8.1'), true);
  assert.equal(satisfiesSpec('2.0.0', '^1.8.1'), false);
  assert.equal(satisfiesSpec('1.8.0', '^1.8.1'), false);
  // Caret pins the leftmost non-zero component: ^0.10.1 admits 0.10.x only.
  assert.equal(satisfiesSpec('0.10.9', '^0.10.1'), true);
  assert.equal(satisfiesSpec('0.11.0', '^0.10.1'), false);
  assert.equal(satisfiesSpec('1.3.0', '~1.2.3'), false);
  assert.equal(satisfiesSpec('1.2.9', '~1.2.3'), true);
  assert.equal(satisfiesSpec('1.0.0', '1.0.0'), true);
  assert.equal(satisfiesSpec('1.0.1', '1.0.0'), false);
  // Undecidable forms return null so the caller fails closed.
  assert.equal(satisfiesSpec('1.0.0', '>=1.0.0'), null);
  assert.equal(satisfiesSpec('1.0.0', '*'), null);
  assert.equal(satisfiesSpec('1.0.0-beta.1', '^1.0.0'), null);
});

test('packageNameOf recovers the package name from a nested key', () => {
  assert.equal(packageNameOf('node_modules/a/node_modules/@s/b'), '@s/b');
  assert.equal(packageNameOf('node_modules/tslib'), 'tslib');
  assert.equal(packageNameOf(''), null);
});

test('still rejects a non-bundled entry that has no resolved at all', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/pkg': { version: '1.0.0', integrity: INTEGRITY },
    },
  };
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('missing_resolved')));
});

test('the repository lockfile is portable', () => {
  const { ok, problems } = inspectLockfileAt(REPO_ROOT);
  assert.equal(ok, true, `repository lockfile is not portable: ${problems.slice(0, 3).join('; ')}`);
});

test('every entry in the repository lockfile resolves to the public registry over https', () => {
  const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
  const hosts = new Set();
  let insecure = 0;
  for (const e of Object.values(lock.packages)) {
    if (!e.resolved) continue;
    const u = new URL(e.resolved);
    hosts.add(u.hostname);
    if (u.protocol !== 'https:') insecure++;
  }
  assert.deepEqual([...hosts], ['registry.npmjs.org'], 'exactly one registry host');
  assert.equal(insecure, 0);
});

test('the six recovered bundled entries validate against their real parent', () => {
  const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
  const PARENT = 'node_modules/@tailwindcss/oxide-wasm32-wasi';
  const six = Object.keys(lock.packages).filter((k) => k.startsWith(`${PARENT}/node_modules/`));
  assert.equal(six.length, 6, 'the six bundled metadata entries must be present');
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, true, problems.slice(0, 3).join('; '));
  for (const k of six) {
    const e = lock.packages[k];
    assert.equal(e.inBundle, true, `${k} must be marked inBundle`);
    assert.equal(e.resolved, undefined, `${k} ships inside the parent tarball, so it has no tarball of its own`);
    assert.ok(lock.packages[PARENT].bundleDependencies.includes(packageNameOf(k)), `${k} must be declared by the parent`);
  }
  // The parent is a wasm32 platform package, so it is never selected on linux/x64.
  assert.deepEqual(lock.packages[PARENT].cpu, ['wasm32']);
  assert.equal(lock.packages[PARENT].optional, true);
});

test('an internal URL reintroduced into any entry fails', () => {
  // The regression this gate exists to prevent: regenerating the lock on a machine whose
  // npm registry env var points at the internal mirror silently re-poisons it.
  const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
  assert.equal(inspectLockfile(lock).ok, true, 'precondition: the repository lock is clean');

  for (const key of ['node_modules/@types/react', 'node_modules/typescript']) {
    const poisoned = JSON.parse(JSON.stringify(lock));
    const name = packageNameOf(key);
    poisoned.packages[key].resolved = `http://package-firewall.replit.local/npm/${name}/-/x-1.0.0.tgz`;
    const { ok, problems } = inspectLockfile(poisoned);
    assert.equal(ok, false, `a re-poisoned ${key} must fail`);
    assert.ok(problems.some((p) => p.includes('internal_tld_host')), problems.join('; '));
  }
});

test('the CLI exits non-zero on a lockfile in the contaminated baseline shape', () => {
  // Reproduces the pre-recovery defect exactly: the internal mirror origin, its `/npm/`
  // mount prefix, plain HTTP, and `devOptional: true` on @types/react — the precise
  // combination that let `npm ci` skip the package and still exit 0.
  //
  // Deliberately a fixture rather than `git show HEAD:package-lock.json`: once the recovery
  // is committed, HEAD *is* the portable lock, so a test asserting HEAD is contaminated
  // would invert and fail. A permanent test cannot depend on a moving baseline (and would
  // also break in any export without a .git directory).
  const contaminated = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/@types/react': {
        version: '19.2.17',
        resolved: 'http://package-firewall.replit.local/npm/@types/react/-/react-19.2.17.tgz',
        integrity: INTEGRITY,
        devOptional: true,
      },
      'node_modules/typescript': {
        version: '5.8.3',
        resolved: 'http://package-firewall.replit.local/npm/typescript/-/typescript-5.8.3.tgz',
        integrity: INTEGRITY,
        dev: true,
      },
    },
  };
  const checker = makeRepoFixture(contaminated);
  const r = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(r.status, 1, `the contaminated shape must be rejected: ${r.stdout}`);
  assert.match(r.stderr, /internal_tld_host/);
  assert.match(r.stdout, /internal hosts\s+2/);
  assert.match(r.stdout, /non-https\s+2/);
  assert.ok(!/replit\.local/.test(r.stdout + r.stderr), 'must not echo the offending URL');
});

test('the CLI exits zero on the recovered repository lockfile', () => {
  const checker = makeRepoFixture(JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')));
  const r = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /internal hosts\s+0/);
  assert.match(r.stdout, /bundled \(in parent\)\s+6/);
  assert.match(r.stdout, /lockfile-portability: OK/);
});

test('output is bounded: counts only, never URLs or tarball paths', () => {
  const { summary } = inspectLockfile(lockWith(PORTABLE_URL));
  const out = formatSummary(summary);
  assert.ok(!out.includes('https://'), 'must not print full URLs');
  assert.ok(!out.includes('/-/'), 'must not print tarball paths');
  assert.ok(out.split('\n').length <= 15, 'summary must stay bounded');
  // Every rejection class must surface a counter, or a lock can fail with an all-zero
  // summary and no indication of why.
  for (const label of ['non-https', 'internal hosts', 'unapproved hosts', 'embedded creds', 'non-default port', 'missing integrity', 'path mismatch', 'bundled (in parent)']) {
    assert.ok(out.includes(label), `summary must report "${label}"`);
  }
});

test('a lockfile failing only on port still reports a non-zero counter', () => {
  const { ok, summary } = inspectLockfile(lockWith('https://registry.npmjs.org:8443/x/-/x-1.0.0.tgz'));
  assert.equal(ok, false);
  assert.equal(summary.nonDefaultPort, 1, 'the summary must not read all-zeros while a problem is reported');
});

test('fails closed on a lockfile with no usable packages map', () => {
  // `typeof [] === 'object'`, so an array would pass a naive object check and yield no
  // entries — a truncated or emptied lockfile must never report ok.
  for (const lock of [{ packages: [] }, { packages: {} }, { packages: null }, {}]) {
    const { ok } = inspectLockfile(lock);
    assert.equal(ok, false, `must reject ${JSON.stringify(lock)}`);
  }
});

test('fails closed on a lockfile with no root entry', () => {
  const lock = {
    lockfileVersion: 3,
    packages: { 'node_modules/x': { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: INTEGRITY } },
  };
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('root')), problems.join('; '));
});

test('a package key cannot forge log lines or leak control characters', () => {
  // Keys come from the artifact under review; a newline in one would otherwise let a
  // hostile lockfile print its own "lockfile-portability: OK" into the CI log.
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/evil\nlockfile-portability: OK[0m': { version: '1.0.0', resolved: 'http://evil.local/x/-/x-1.0.0.tgz', integrity: INTEGRITY },
    },
  };
  const { problems } = inspectLockfile(lock);
  const joined = problems.join('|');
  assert.ok(!joined.includes('\n'), 'must not emit a newline from a package key');
  assert.ok(!joined.includes(''), 'must not emit an ANSI escape from a package key');
});

test('the checker depends only on Node built-ins, so it can run before npm ci', () => {
  const src = readFileSync(CHECKER, 'utf8');
  // `from`, bare `import 'x'`, dynamic `import('x')` and `require('x')`, single- or
  // double-quoted. Anything outside node: would make the gate need the very install it
  // is supposed to run before.
  const specifiers = [...src.matchAll(/\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, 'expected the checker to import something');
  for (const s of specifiers) {
    assert.ok(s.startsWith('node:'), `checker must depend only on Node built-ins, found: ${s}`);
  }
});

test('the CLI exits non-zero on an unportable lockfile, without echoing the URL', () => {
  // The gate's whole purpose is a non-zero exit before npm ci; assert it end-to-end
  // against a real fixture rather than inferring it from the API.
  const checker = makeRepoFixture(lockWith('http://package-firewall.replit.local/npm/x/-/x-1.0.0.tgz'));
  const r = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /internal_tld_host/);
  assert.match(r.stderr, /lockfile-portability: FAILED/);
  assert.ok(!/replit\.local/.test(r.stdout + r.stderr), 'must not echo the offending URL');
});

test('the CLI exits zero on a portable lockfile fixture', () => {
  const checker = makeRepoFixture(lockWith(PORTABLE_URL));
  const r = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /lockfile-portability: OK/);
});

test('an entry cannot skip validation by self-declaring inBundle', () => {
  // `inBundle` is asserted by the file under review, so the skip must depend on a real
  // validated parent tarball — not on the flag.
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/evil': { version: '1.0.0', inBundle: true },
    },
  };
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('orphan_bundled_entry')), problems.join('; '));
});

test('a bundled entry whose parent is itself unportable is not skipped', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/parent': { version: '1.0.0', resolved: 'http://package-firewall.replit.local/npm/p/-/p-1.0.0.tgz', integrity: INTEGRITY },
      'node_modules/parent/node_modules/bundled': { version: '2.0.0', inBundle: true },
    },
  };
  const { ok, problems } = inspectLockfile(lock);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('node_modules/parent: internal_tld_host')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('orphan_bundled_entry')), 'the child must not ride on an unvalidated parent');
});

test('parentPackageKey finds the enclosing package of a nested entry', () => {
  assert.equal(parentPackageKey('node_modules/a/node_modules/b'), 'node_modules/a');
  assert.equal(parentPackageKey('node_modules/@scope/a/node_modules/@s/b'), 'node_modules/@scope/a');
  assert.equal(parentPackageKey('node_modules/a'), null);
  assert.equal(parentPackageKey(''), null);
});

test('the checker reads its own repository, not the working directory', () => {
  // Run a fixture checker (portable lock) from a cwd whose repository lock differs. If the
  // verdict tracked cwd, this would report the other tree; it must report its own.
  const checker = makeRepoFixture(lockWith(PORTABLE_URL));
  const r = spawnSync(process.execPath, [checker], { cwd: join(REPO, 'src'), encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /lockfile-portability: OK/);
  assert.match(r.stdout, /package entries\s+2/, 'must have inspected the fixture lock, not the repository lock');
});
