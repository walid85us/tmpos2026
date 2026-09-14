// Phase 4.0 M6 — the trusted-proxy client-address contract (G-UNAUTH, G-IDEMPOT).
//
// Unit half: normalization (IPv4, IPv6, IPv4-mapped IPv6), limiter grouping (IPv4 per address,
// IPv6 per /64), the trusted-proxy CIDR contract (canonical, capped, no universal range) and the
// right-to-left resolver. Socket half: synthetic documentation-range addresses in
// X-Forwarded-For cross a real loopback socket (127.0.0.1) into createApp, whose recording
// limiter shows which bucket each request spends — so spoof resistance and per-client separation
// are observed at the limiter port, not inferred. This sandbox has no IPv6 stack, so IPv6 clients
// arrive as forwarded entries from a trusted IPv4 proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import {
  MAX_FORWARDED_HOPS, MAX_FORWARDED_LENGTH, MAX_TRUSTED_PROXIES, limiterSubjectOf, parseAddress, parseTrustedProxies,
  resolveClientAddress,
} from './clientAddress.js';
import type { ClientAddress } from './clientAddress.js';
import { createLimiterKeyring } from './rateLimit.js';
import type { DistributedRateLimiter, RateLimitRequest } from './rateLimit.js';
import { EnforcementSetupError } from './routes.js';
import type { RouteDefinition } from './routes.js';
import { TEST_RATE_LIMIT_KEY, createMemoryRateLimiter } from './rateLimiter.testkit.js';

const subjectOf = (text: string): string | null => {
  const address = parseAddress(text);
  return address === null ? null : limiterSubjectOf(address);
};

// --- normalization and grouping --------------------------------------------------------------

test('addresses normalize to one canonical form: an IPv4-mapped IPv6 address is its IPv4 address', () => {
  const cases: Array<[string, string]> = [
    ['203.0.113.7', '4:203.0.113.7'],
    ['::ffff:203.0.113.7', '4:203.0.113.7'],
    ['::FFFF:cb00:7107', '4:203.0.113.7'],
    ['0:0:0:0:0:ffff:203.0.113.7', '4:203.0.113.7'],
    ['0.0.0.0', '4:0.0.0.0'],
    ['255.255.255.255', '4:255.255.255.255'],
    ['2001:db8:1:2:3:4:5:6', '6:20010db800010002'],
    ['2001:DB8:1:2::', '6:20010db800010002'],
    ['2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '6:20010db800010002'],
    ['::1', '6:0000000000000000'],
    ['::', '6:0000000000000000'],
  ];
  for (const [text, subject] of cases) assert.equal(subjectOf(text), subject, text);
});

test('anything but a bare IP address is refused: ports, zones, brackets, hostnames, obfuscated or partial forms', () => {
  for (const text of [
    '', ' 203.0.113.7', '203.0.113.7 ', '203.0.113.7:443', '[2001:db8::1]', '[2001:db8::1]:443', 'fe80::1%eth0', 'fe80::1%25eth0',
    'localhost', 'pos.example.test', 'unknown', '_hidden', '0203.0.113.7', '203.0.113', '203.0.113.7.1', '256.0.113.7',
    '0x7f.0.0.1', '2130706433', '203.0.113.7/32', '::ffff:203.0.113', '1:2:3:4:5:6:7:8:9', ':::1', '2001:db8::1::2', 'g::1',
    `2001:db8::1${' '.repeat(40)}`,
  ]) {
    assert.equal(parseAddress(text), null, JSON.stringify(text));
  }
});

test('limiter grouping: IPv4 per address, IPv6 per /64, and adjacent /64s never share a bucket', () => {
  assert.notEqual(subjectOf('203.0.113.7'), subjectOf('203.0.113.8'), 'each IPv4 address is its own client');
  assert.equal(subjectOf('2001:db8:0:1::1'), subjectOf('2001:db8:0:1:ffff:ffff:ffff:ffff'), 'one /64 is one client');
  assert.notEqual(subjectOf('2001:db8:0:1:ffff:ffff:ffff:ffff'), subjectOf('2001:db8:0:2::'), 'the next /64 is another client');
  assert.notEqual(subjectOf('2001:db8:0:1::1'), subjectOf('2001:db8:0:0:ffff::1'), 'the /64 below is another client');
  assert.notEqual(subjectOf('::ffff:198.51.100.4'), subjectOf('::198.51.100.4'), 'an IPv4-compatible address is not mapped');
});

// M6-IDEMPOT-P2 correction: only ::ffff:0:0/96 carries a client's IPv4 identity. A NAT64 (64:ff9b::/96)
// or 6to4 (2002::/16) address is an IPv6 client, grouped by its /64 like any other — never by the
// IPv4 bits it embeds.

test('an IPv4-mapped address and its IPv4 address are one client in one bucket', () => {
  for (const mapped of ['::ffff:198.51.100.4', '::FFFF:198.51.100.4', '0:0:0:0:0:ffff:c633:6404', '::ffff:c633:6404']) {
    assert.equal(subjectOf(mapped), subjectOf('198.51.100.4'), mapped);
  }
  assert.equal(subjectOf('198.51.100.4'), '4:198.51.100.4');
  assert.equal(subjectOf('::ffff:0:198.51.100.4'), '6:0000000000000000', 'an IPv4-translated address (::ffff:0:0:0/96) is not mapped');
});

test('a NAT64 address and the IPv4 address it embeds never share a bucket', () => {
  assert.equal(subjectOf('64:ff9b::198.51.100.7'), '6:0064ff9b00000000', 'grouped by its /64');
  assert.notEqual(subjectOf('64:ff9b::198.51.100.7'), subjectOf('198.51.100.7'));
  assert.notEqual(subjectOf('64:ff9b::198.51.100.7'), subjectOf('::ffff:198.51.100.7'));
});

test('NAT64 addresses share a bucket exactly when they share an IPv6 /64', () => {
  assert.equal(subjectOf('64:ff9b::198.51.100.7'), subjectOf('64:ff9b::203.0.113.9'), 'the well-known /96 lies inside one /64');
  assert.notEqual(subjectOf('64:ff9b::198.51.100.7'), subjectOf('64:ff9b:1::198.51.100.7'), 'a local-use NAT64 prefix is another /64');
  assert.equal(subjectOf('64:ff9b:1::198.51.100.7'), subjectOf('64:ff9b:1:0:1::198.51.100.8'), 'one /64 of the local-use prefix');
  assert.notEqual(subjectOf('64:ff9b:1::198.51.100.7'), subjectOf('64:ff9b:1:1::198.51.100.7'), 'the next /64 of the local-use prefix');
});

test('6to4 addresses share a bucket exactly when they share an IPv6 /64', () => {
  assert.equal(subjectOf('2002:c633:6407:1::1'), '6:2002c63364070001');
  assert.equal(subjectOf('2002:c633:6407:1::1'), subjectOf('2002:c633:6407:1:ffff:ffff:ffff:ffff'), 'one /64');
  assert.notEqual(subjectOf('2002:c633:6407:1::1'), subjectOf('2002:c633:6407:2::1'), 'another /64 under the same 6to4 prefix');
  assert.notEqual(subjectOf('2002:c633:6407::1'), subjectOf('198.51.100.7'), 'never the IPv4 address its prefix embeds');
});

test('equivalent IPv6 textual forms normalize to one subject', () => {
  for (const forms of [
    ['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:DB8:0:0:0:0:0:1', '2001:db8:0::1', '2001:db8::0:1'],
    ['64:ff9b::198.51.100.7', '64:ff9b::c633:6407', '0064:FF9B:0000:0000:0000:0000:C633:6407', '64:ff9b:0:0:0:0:198.51.100.7'],
    ['2002:c633:6407::', '2002:C633:6407:0::0', '2002:c633:6407:0:0:0:0:0'],
  ]) {
    const subjects = forms.map(subjectOf);
    assert.ok(subjects.every((s) => s !== null), forms[0]);
    assert.equal(new Set(subjects).size, 1, forms[0]);
  }
});

// --- the trusted-proxy list ----------------------------------------------------------------------

test('the trusted-proxy list takes exact canonical CIDRs only, capped, with no universal or near-universal range', () => {
  const trusted = parseTrustedProxies(['10.0.0.0/8', '203.0.113.7/32', '2001:db8::/32', '::ffff:198.51.100.0/120']);
  assert.equal(trusted.size, 4);
  const at = (text: string): boolean => trusted.has(parseAddress(text) as ClientAddress);
  for (const inside of ['10.255.0.1', '203.0.113.7', '2001:db8:ffff::1', '198.51.100.9', '::ffff:10.1.2.3']) assert.ok(at(inside), inside);
  for (const outside of ['11.0.0.1', '203.0.113.8', '2001:db9::1', '198.51.101.1', '::a00:1']) assert.ok(!at(outside), outside);
  assert.equal(parseTrustedProxies([]).size, 0, 'an empty list: clients connect directly');

  const cases: Array<[unknown, string]> = [
    ['10.0.0.0/8', 'a string, not a list'], [undefined, 'absent'], [[10], 'a non-string entry'],
    [['0.0.0.0/0'], 'IPv4 universal'], [['::/0'], 'IPv6 universal'], [['::ffff:0:0/96'], 'every IPv4 address, spelled as mapped IPv6'],
    [['0.0.0.0/1', '128.0.0.0/1'], 'universal in two halves'], [['10.0.0.0/7'], 'below the IPv4 floor'], [['2000::/3'], 'below the IPv6 floor'],
    [['2001:db8::/31'], 'just below the IPv6 floor'], [['::/32'], 'an IPv6 range around the IPv4-mapped block'],
    [['10.0.0.0/8', '10.1.0.0/16'], 'overlapping ranges'], [['10.0.0.0/8', '11.0.0.0/8', '12.0.0.0/8'], 'more IPv4 space than two /8s'],
    [['10.0.0.1/8'], 'host bits set'], [['10.0.0.0'], 'no prefix length'], [['10.0.0.0/33'], 'an IPv4 prefix too long'],
    [['::/129'], 'an IPv6 prefix too long'], [['10.0.0.0/08'], 'a zero-padded prefix'], [[' 10.0.0.0/8'], 'whitespace'],
    [['fe80::%eth0/64'], 'a zone'], [['[2001:db8::]/32'], 'brackets'], [['localhost/32'], 'a hostname'],
    [['10.0.0.0/8', '10.0.0.0/8'], 'a duplicate'], [['::ffff:10.0.0.0/104', '10.0.0.0/8'], 'a duplicate spelled as mapped IPv6'],
    [Array.from({ length: MAX_TRUSTED_PROXIES + 1 }, (_, i) => `10.${i}.0.0/16`), 'over the cap'],
  ];
  for (const [raw, label] of cases) {
    assert.throws(() => parseTrustedProxies(raw),
      (e: unknown) => e instanceof EnforcementSetupError && e.code === 'trusted_proxies_invalid' && !e.message.includes('/'), label);
  }
});

// --- the resolver ----------------------------------------------------------------------------------

const PROXIES = parseTrustedProxies(['10.0.0.0/8']);
/** The resolver's answer as a limiter subject, or its refusal code. */
const resolve = (peer: unknown, chain: unknown, trusted = PROXIES): string => {
  const r = resolveClientAddress(peer, chain, trusted);
  return typeof r === 'string' ? r : limiterSubjectOf(r);
};

test("the socket peer is the client unless it is a trusted proxy; an untrusted peer's forwarding is never read", () => {
  assert.equal(resolve('203.0.113.7', undefined), '4:203.0.113.7');
  assert.equal(resolve('203.0.113.7', '198.51.100.1'), '4:203.0.113.7', 'a spoofed chain from an untrusted peer');
  assert.equal(resolve('203.0.113.7', 'garbage, [::1]:80, fe80::1%eth0'), '4:203.0.113.7', 'an untrusted chain is never even parsed');
  assert.equal(resolve('::ffff:203.0.113.7', '198.51.100.1'), '4:203.0.113.7');
  assert.equal(resolve('10.0.0.2', '198.51.100.1', parseTrustedProxies([])), '4:10.0.0.2', 'with no trusted proxy, a proxy is just a client');
  for (const peer of [undefined, '', 'fe80::1%eth0', 'localhost', 42]) {
    assert.equal(resolve(peer, undefined), 'client_address_unresolvable', String(peer));
  }
});

test('behind trusted proxies the chain is walked right to left to the first untrusted hop', () => {
  assert.equal(resolve('10.0.0.2', '198.51.100.1'), '4:198.51.100.1', 'one trusted proxy');
  assert.equal(resolve('10.0.0.2', '198.51.100.1, 10.0.0.9'), '4:198.51.100.1', 'a chain of trusted proxies');
  assert.equal(resolve('::ffff:10.0.0.2', '198.51.100.1'), '4:198.51.100.1', 'a trusted proxy seen as mapped IPv6');
  assert.equal(resolve('10.0.0.2', '192.0.2.66, 198.51.100.1, 10.0.0.9'), '4:198.51.100.1', 'the first untrusted hop, never the leftmost entry');
  assert.equal(resolve('10.0.0.2', '10.0.0.77, 198.51.100.1'), '4:198.51.100.1', 'a trusted-looking entry the client wrote is never reached');
  assert.equal(resolve('10.0.0.2', '10.0.0.5, 10.0.0.9'), 'forwarded_chain_invalid', 'trusted proxies only: no client in the chain, refused');
  assert.equal(resolve('10.0.0.2', '198.51.100.1 ,\t10.0.0.9'), '4:198.51.100.1', 'optional whitespace around the commas');
  assert.equal(resolve('10.0.0.2', '2001:db8:1:2::abcd'), '6:20010db800010002', 'an IPv6 client behind an IPv4 proxy');
  assert.equal(resolve('10.0.0.2', '::ffff:198.51.100.1'), '4:198.51.100.1', 'a mapped client');
});

test("a trusted proxy's chain is refused when missing, repeated, malformed where examined, oversized or overlong", () => {
  assert.equal(resolve('10.0.0.2', undefined), 'forwarded_chain_missing', 'never bucketed under the proxy');
  assert.equal(resolve('10.0.0.2', ['198.51.100.1', '198.51.100.2']), 'forwarded_chain_ambiguous', "several lines: their order need not be the hops' order");
  // The client, then `n` trusted hops: at most MAX_FORWARDED_HOPS entries are examined.
  const chain = (n: number): string => ['198.51.100.1', ...Array.from({ length: n }, (_, i) => `10.0.0.${i + 1}`)].join(', ');
  assert.equal(resolve('10.0.0.2', chain(MAX_FORWARDED_HOPS - 1)), '4:198.51.100.1', 'the client is the last entry examined');
  assert.equal(resolve('10.0.0.2', chain(MAX_FORWARDED_HOPS)), 'forwarded_chain_too_long', 'more trusted hops than may be examined');
  assert.equal(resolve('10.0.0.2', `${' '.repeat(MAX_FORWARDED_LENGTH)}198.51.100.1`), 'forwarded_chain_too_long', 'over the length cap');
  for (const bad of [
    '', ' ', '198.51.100.1,', '198.51.100.1,,10.0.0.9', '198.51.100.1:443', '[2001:db8::1]', '[2001:db8::1]:443',
    'fe80::1%eth0', 'unknown', 'pos.example.test', 'for=198.51.100.1', '198.51.100.1;proto=https', '"198.51.100.1"',
    '198.51.100.1 10.0.0.9', '0x7f.0.0.1',
  ]) {
    assert.equal(resolve('10.0.0.2', bad), 'forwarded_chain_invalid', JSON.stringify(bad));
  }
});

test('entries left of the client are never examined: whatever the client wrote there is ignored', () => {
  for (const chain of [
    ',198.51.100.1', 'unknown, [::1]:80, fe80::1%eth0, 198.51.100.1', 'x, 192.0.2.1, 198.51.100.1, 10.0.0.9',
    `${Array.from({ length: 20 }, (_, i) => `192.0.2.${i}`).join(',')}, 198.51.100.1`,
  ]) {
    assert.equal(resolve('10.0.0.2', chain), '4:198.51.100.1', chain);
  }
});

// --- real loopback sockets ---------------------------------------------------------------------------

const OPEN: RouteDefinition = {
  method: 'GET', path: '/v1/open', policy: { access: 'public' }, body: { kind: 'none' }, idempotency: 'none',
  handler: (_req, res) => { res.status(200).json({ ok: true }); },
};
const keyring = createLimiterKeyring(TEST_RATE_LIMIT_KEY);
/** The pseudonymous bucket key the runtime namespace spends for `subject`. */
const bucket = (subject: string): string => keyring.keyOf('runtime', 'client', subject);

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function send(port: number, path: string, headers: Record<string, string | string[]> = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Harness { port: number; requests: RateLimitRequest[]; logs: string[] }

/**
 * Serve OPEN behind `trustedProxies`, spending a recording in-memory limiter. `limit` tightens
 * every bucket for the test (the runtime still sends its own policy on the request).
 */
async function withProxyApp(trustedProxies: readonly string[], fn: (h: Harness) => Promise<void>, limit?: number): Promise<void> {
  const requests: RateLimitRequest[] = [];
  const logs: string[] = [];
  const memory = createMemoryRateLimiter();
  const limiter: DistributedRateLimiter = {
    consume: (request: RateLimitRequest, signal: AbortSignal) => {
      requests.push(request);
      return memory.consume(limit === undefined ? request : { ...request, limit }, signal);
    },
    probe: (signal: AbortSignal) => memory.probe(signal),
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line: string) => { logs.push(line); } }, routes: [OPEN],
    limits: { limiter, keySecret: TEST_RATE_LIMIT_KEY, trustedProxies },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn({ port: (server.address() as AddressInfo).port, requests, logs });
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
}

const SPOOFS = ['198.51.100.1', '198.51.100.2', '2001:db8::1'];
const spoofing = (spoof: string): Record<string, string> => ({
  'x-forwarded-for': spoof, forwarded: `for=${spoof}`, 'x-real-ip': spoof, 'true-client-ip': spoof, 'cf-connecting-ip': spoof,
});

test('a direct client is bucketed by its socket peer, whatever forwarding headers it sends', async () => {
  for (const trustedProxies of [[], ['10.0.0.0/8']]) {
    await withProxyApp(trustedProxies, async ({ port, requests }) => {
      for (const spoof of SPOOFS) assert.equal((await send(port, '/v1/open', spoofing(spoof))).status, 200, spoof);
      assert.deepEqual([...new Set(requests.map((r) => r.key))], [bucket('4:127.0.0.1')], `trusted: ${trustedProxies.join(',') || 'none'}`);
    });
  }
});

test('behind a trusted proxy each forwarded client has its own bucket, and a prefix the client wrote cannot move it', async () => {
  await withProxyApp(['127.0.0.1/32'], async ({ port, requests }) => {
    for (const chain of ['198.51.100.1', '198.51.100.2', '192.0.2.50, 198.51.100.1', '10.9.9.9, 198.51.100.1, 127.0.0.1']) {
      assert.equal((await send(port, '/v1/open', { 'x-forwarded-for': chain })).status, 200, chain);
    }
    assert.deepEqual(requests.map((r) => r.key),
      [bucket('4:198.51.100.1'), bucket('4:198.51.100.2'), bucket('4:198.51.100.1'), bucket('4:198.51.100.1')]);
  });
});

test('limits stay per client behind the proxy: one client is refused with 429, another is not, and spoofing cannot escape', async () => {
  await withProxyApp(['127.0.0.1/32'], async ({ port }) => {
    const a = { 'x-forwarded-for': '198.51.100.1' };
    assert.equal((await send(port, '/v1/open', a)).status, 200);
    assert.equal((await send(port, '/v1/open', a)).status, 200);
    const refused = await send(port, '/v1/open', a);
    assert.equal(refused.status, 429);
    assert.match(String(refused.headers['retry-after']), /^[1-9][0-9]*$/);
    assert.ok(Number(refused.headers['retry-after']) <= 60);
    for (const prefix of ['192.0.2.1', '192.0.2.2', '10.1.1.1']) {
      assert.equal((await send(port, '/v1/open', { 'x-forwarded-for': `${prefix}, 198.51.100.1` })).status, 429, `prefix ${prefix}`);
    }
    assert.equal((await send(port, '/v1/open', { 'x-forwarded-for': '198.51.100.2' })).status, 200, 'another client behind the same proxy');
  }, 2);
});

test('a broken chain from the trusted proxy is a bounded 400 that echoes and logs no address', async () => {
  await withProxyApp(['127.0.0.1/32'], async ({ port, requests, logs }) => {
    const hops = ['198.51.100.1', ...Array.from({ length: MAX_FORWARDED_HOPS }, () => '127.0.0.1')].join(', ');
    const cases: Array<[Record<string, string | string[]>, string]> = [
      [{}, 'forwarded_chain_missing'],
      [{ 'x-forwarded-for': ['198.51.100.1', '198.51.100.2'] }, 'forwarded_chain_ambiguous'],
      [{ 'x-forwarded-for': hops }, 'forwarded_chain_too_long'],
      [{ 'x-forwarded-for': '198.51.100.1:443' }, 'forwarded_chain_invalid'],
    ];
    const bodies: string[] = [];
    for (const [headers, reason] of cases) {
      const r = await send(port, '/v1/open', headers);
      assert.equal(r.status, 400, reason);
      const body = JSON.parse(r.body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], reason);
      assert.equal(body.error, 'invalid_request', reason);
      bodies.push(r.body);
    }
    assert.equal(requests.length, 0, 'an unresolvable client spends no bucket');
    for (let i = 0; i < 200 && logs.length < cases.length; i++) await new Promise((r) => setTimeout(r, 5));
    const reasons = logs.map((line) => (JSON.parse(line) as Record<string, unknown>).reason);
    assert.deepEqual(reasons, cases.map(([, reason]) => reason));
    assert.doesNotMatch(`${bodies.join('')}${logs.join('')}`, /198\.51\.100|127\.0\.0\.1/, 'no address in a response or the log');
  });
});

test('the operational probes answer through the proxy even with a broken chain, and spend no bucket', async () => {
  await withProxyApp(['127.0.0.1/32'], async ({ port, requests }) => {
    for (const headers of [{}, { 'x-forwarded-for': 'garbage' }, { 'x-forwarded-for': '198.51.100.1' }]) {
      assert.equal((await send(port, '/health', headers)).status, 200);
      assert.equal((await send(port, '/readiness', headers)).status, 200);
    }
    assert.equal(requests.length, 0, 'neither probe consumes a rate-limit bucket');
  });
});

test('IPv6 clients group by /64 through the proxy, and a mapped client is its IPv4 client', async () => {
  await withProxyApp(['127.0.0.1/32'], async ({ port, requests }) => {
    for (const chain of ['2001:db8:0:1::1', '2001:db8:0:1::2', '2001:db8:0:2::1', '::ffff:198.51.100.7', '198.51.100.7']) {
      assert.equal((await send(port, '/v1/open', { 'x-forwarded-for': chain })).status, 200, chain);
    }
    const [a, b, c, mapped, v4] = requests.map((r) => r.key);
    assert.equal(a, b, 'one /64');
    assert.notEqual(b, c, 'adjacent /64');
    assert.equal(mapped, v4, 'mapped == IPv4');
    assert.equal(a, bucket('6:20010db800000001'));
    assert.equal(v4, bucket('4:198.51.100.7'));
    assert.ok(requests.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r.key)), 'the port sees pseudonymous keys only');
    assert.doesNotMatch(JSON.stringify(requests), /2001|198\.51|127\.0\.0/, 'no raw address crosses the limiter port');
  });
});

test('NAT64 and 6to4 clients are bucketed as their IPv6 /64 through the proxy, and no raw address reaches a key, a response or the log', async () => {
  await withProxyApp(['127.0.0.1/32'], async ({ port, requests, logs }) => {
    const chains = ['64:ff9b::198.51.100.7', '198.51.100.7', '::ffff:198.51.100.7', '64:ff9b::203.0.113.9', '2002:c633:6407:1::1', '2002:c633:6407:2::1'];
    const seen: string[] = [];
    for (const chain of chains) {
      const r = await send(port, '/v1/open', { 'x-forwarded-for': chain });
      assert.equal(r.status, 200, chain);
      seen.push(r.body, JSON.stringify(r.headers));
    }
    const [nat64, v4, mapped, nat64Other, sixToFour, sixToFourNext] = requests.map((r) => r.key);
    assert.equal(nat64, bucket('6:0064ff9b00000000'), 'a NAT64 client spends its /64 bucket');
    assert.equal(v4, bucket('4:198.51.100.7'));
    assert.equal(mapped, v4, 'a mapped client spends its IPv4 bucket');
    assert.notEqual(nat64, v4, 'never the bucket of the IPv4 address it embeds');
    assert.equal(nat64Other, nat64, 'NAT64 clients in one /64 share its bucket');
    assert.equal(sixToFour, bucket('6:2002c63364070001'), 'a 6to4 client spends its /64 bucket');
    assert.notEqual(sixToFourNext, sixToFour, 'the next /64 of one 6to4 prefix is another bucket');
    assert.ok(requests.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r.key)), 'the port sees pseudonymous keys only');
    for (let i = 0; i < 200 && logs.length < chains.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(logs.length, chains.length, 'one request log line each');
    assert.doesNotMatch(`${JSON.stringify(requests)}${seen.join('')}${logs.join('')}`, /64:ff9b|2002:c633|198\.51\.100|203\.0\.113|::ffff|127\.0\.0\.1/i,
      'no raw address in a limiter key, a response or a log line');
  });
});
