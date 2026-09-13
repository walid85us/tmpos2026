// Phase 4.0 M6 — the one client-address resolver: the trusted-proxy contract (G-UNAUTH, G-IDEMPOT).
//
// The socket peer is the client unless it is a configured trusted proxy. Only then is
// X-Forwarded-For read, and only its right-hand part is believed: walking the chain right to left
// from the peer, the first address that is not a trusted proxy is the client — never the leftmost
// entry merely because the header holds it, since everything left of the proxies' own entries is
// whatever the client chose to write, and is never even parsed. A chain of trusted proxies only is
// refused: under the deployment contract a client always stands left of them. Forwarded, X-Real-IP and every other client-set header are
// never read, and trust is never inferred from a request: the trusted set is configuration only
// (parseTrustedProxies), and an untrusted peer's forwarding headers are not read at all.
//
// Fail closed. A trusted peer that sends no chain is refused rather than bucketed under the proxy,
// which would put every client behind it in one bucket; so is a chain split over several header
// lines (their order need not be the hops' order), one over MAX_FORWARDED_LENGTH characters, one
// whose right-hand MAX_FORWARDED_HOPS entries are all trusted proxies with more to come, and one
// whose examined part holds anything but bare IP addresses — a port, a zone, brackets, a hostname,
// an empty entry. A refusal only ever costs the request that carried it.
//
// The contract rests on the deployment (docs/phase-4/08 G-UNAUTH): a trusted range holds proxy
// egress addresses only, the runtime is reachable only through those proxies, the first trusted
// hop overwrites or appends to the chain — never passes a client's through untouched — and every
// hop between it and the runtime is trusted.
//
// One canonical form: strict dotted-quad IPv4 (no leading zeros) or RFC 4291 IPv6 text, and an
// IPv4-mapped IPv6 address (::ffff:a.b.c.d) folds to its IPv4 address before it is matched or
// grouped, so one client never holds two buckets. Grouping (limiterSubjectOf): an IPv4 client is
// its own address; an IPv6 client is its /64, the smallest prefix a subscriber is routinely
// assigned — except that NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses group by the IPv4
// address they carry. No address leaves this module except as a limiter subject, which
// rateLimit.ts keys with a secret before any storage; none is logged, rendered or returned.
import { isIPv6 } from 'node:net';
import { EnforcementSetupError } from './routes.js';

type Family = 4 | 6;

/** An address in canonical form: IPv4 (IPv4-mapped IPv6 included) or IPv6, with its value. */
export interface ClientAddress {
  readonly family: Family;
  readonly value: bigint;
}

export type ClientAddressRefusal =
  | 'client_address_unresolvable'
  | 'forwarded_chain_missing'
  | 'forwarded_chain_ambiguous'
  | 'forwarded_chain_too_long'
  | 'forwarded_chain_invalid';

/** The trusted proxies: exact CIDRs, fixed at startup. */
export interface TrustedProxies {
  readonly size: number;
  has(address: ClientAddress): boolean;
}

export const MAX_TRUSTED_PROXIES = 32;
export const MAX_FORWARDED_HOPS = 8;
export const MAX_FORWARDED_LENGTH = 512;

const WIDTH: Readonly<Record<Family, number>> = Object.freeze({ 4: 32, 6: 128 });
// The broadest range one CIDR may trust: anything wider is a universal or near-universal range.
const MIN_PREFIX: Readonly<Record<Family, number>> = Object.freeze({ 4: 8, 6: 32 });
// The most IPv4 space the whole list may trust (two /8s), so no universal range passes in pieces.
// IPv6 needs no such sum: 32 ranges no broader than /32 hold at most a /27.
const MAX_TRUSTED_IPV4 = 1n << 25n;
// The longest IPv6 text: eight groups with an embedded IPv4 tail.
const MAX_ADDRESS_LENGTH = 45;
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPV4_RE = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const CIDR_RE = /^([^/]+)\/(0|[1-9][0-9]{0,2})$/;
// RFC 9110 optional whitespace around a list element: SP and HTAB only.
const OWS_RE = /^[ \t]+|[ \t]+$/g;
// The top 96 bits of ::ffff:0:0/96, where IPv6 carries an IPv4 address.
const MAPPED = 0xffffn;
// The top 96 bits of the NAT64 well-known prefix 64:ff9b::/96, and the top 16 of 6to4, 2002::/16.
const NAT64 = 0x64ff9b0000000000000000n;
const SIX_TO_FOUR = 0x2002n;

const addressOf = (family: Family, value: bigint): ClientAddress => Object.freeze({ family, value });

function ipv4Value(text: string): bigint | null {
  return IPV4_RE.test(text) ? text.split('.').reduce((v, octet) => (v << 8n) | BigInt(octet), 0n) : null;
}

/** The 128-bit value of RFC 4291 IPv6 text; a zone identifier makes it no address. */
function ipv6Value(text: string): bigint | null {
  if (text.length > MAX_ADDRESS_LENGTH || text.includes('%') || !isIPv6(text)) return null;
  const words = (part: string): bigint[] | null => {
    const out: bigint[] = [];
    for (const group of part === '' ? [] : part.split(':')) {
      if (!group.includes('.')) {
        out.push(BigInt(`0x${group}`));
        continue;
      }
      const v4 = ipv4Value(group);
      if (v4 === null) return null;
      out.push(v4 >> 16n, v4 & 0xffffn);
    }
    return out;
  };
  const gap = text.indexOf('::');
  const head = words(gap < 0 ? text : text.slice(0, gap));
  const tail = gap < 0 ? [] : words(text.slice(gap + 2));
  if (head === null || tail === null) return null;
  const zeros = 8 - head.length - tail.length;
  if (gap < 0 ? zeros !== 0 : zeros < 1) return null;
  return [...head, ...new Array<bigint>(zeros).fill(0n), ...tail].reduce((v, word) => (v << 16n) | word, 0n);
}

/** A canonical address, or null for anything but a bare IPv4 or IPv6 address. */
export function parseAddress(text: unknown): ClientAddress | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_ADDRESS_LENGTH) return null;
  const v4 = ipv4Value(text);
  if (v4 !== null) return addressOf(4, v4);
  const v6 = ipv6Value(text);
  if (v6 === null) return null;
  // IPv4 carried in IPv6 is one client in one form.
  return (v6 >> 32n) === MAPPED ? addressOf(4, v6 & 0xffffffffn) : addressOf(6, v6);
}

/** The subject a client is limited as: an IPv4 address or an IPv6 /64. Never stored as is (rateLimit.ts keys it). */
export function limiterSubjectOf(address: ClientAddress): string {
  let v4: bigint | null = address.family === 4 ? address.value : null;
  // IPv4 clients behind a transition prefix group by the address they carry: NAT64 would put every
  // translated client in one /64, and 6to4 hands the holder of one IPv4 address 65 536 /64s.
  if (address.family === 6 && (address.value >> 32n) === NAT64) v4 = address.value & 0xffffffffn;
  if (address.family === 6 && (address.value >> 112n) === SIX_TO_FOUR) v4 = (address.value >> 80n) & 0xffffffffn;
  if (v4 !== null) {
    const ipv4 = v4;
    return `4:${[24n, 16n, 8n, 0n].map((shift) => String((ipv4 >> shift) & 0xffn)).join('.')}`;
  }
  return `6:${(address.value >> 64n).toString(16).padStart(16, '0')}`;
}

interface Network {
  readonly family: Family;
  readonly value: bigint;
  readonly prefix: number;
}

const within = (address: ClientAddress, net: Network): boolean => {
  const host = BigInt(WIDTH[net.family] - net.prefix);
  return address.family === net.family && (address.value >> host) === (net.value >> host);
};
const sizeOf = (net: Network): bigint => 1n << BigInt(WIDTH[net.family] - net.prefix);

/** One canonical CIDR — `address/prefix`, no host bits set, no broader than the floor — or null. */
function networkOf(entry: unknown): Network | null {
  const m = typeof entry === 'string' ? CIDR_RE.exec(entry) : null;
  if (m === null) return null;
  const ipv6 = m[1].includes(':');
  let family: Family = ipv6 ? 6 : 4;
  let value = ipv6 ? ipv6Value(m[1]) : ipv4Value(m[1]);
  let prefix = Number(m[2]);
  // A range inside ::ffff:0:0/96 is IPv4 carried in IPv6: judge it as the IPv4 range it is.
  if (value !== null && family === 6 && prefix >= 96 && (value >> 32n) === MAPPED) {
    family = 4;
    value &= 0xffffffffn;
    prefix -= 96;
  }
  if (value === null || prefix > WIDTH[family] || prefix < MIN_PREFIX[family]) return null;
  if ((value & (sizeOf({ family, value, prefix }) - 1n)) !== 0n) return null; // host bits set: not canonical
  const net: Network = Object.freeze({ family, value, prefix });
  // An IPv6 range around the mapped block would trust every IPv4 client, or — since mapped
  // addresses are matched as IPv4 — silently none: either way it is not what it says.
  return family === 6 && within(addressOf(6, MAPPED << 32n), net) ? null : net;
}

/**
 * The trusted proxies from exact canonical CIDRs: at most MAX_TRUSTED_PROXIES of them, none
 * overlapping another, and at most MAX_TRUSTED_IPV4 IPv4 addresses in all. Startup fails closed on
 * anything else, with a bounded code and never the rejected input.
 */
export function parseTrustedProxies(raw: unknown): TrustedProxies {
  const refuse = (): never => { throw new EnforcementSetupError('trusted_proxies_invalid'); };
  if (!Array.isArray(raw) || raw.length > MAX_TRUSTED_PROXIES) refuse();
  const networks: Network[] = [];
  let ipv4Space = 0n;
  for (const entry of raw as unknown[]) {
    const net = networkOf(entry);
    // Two CIDRs overlap exactly when one holds the other's network address; a duplicate is one case.
    if (net === null || networks.some((other) => within(addressOf(net.family, net.value), other) || within(addressOf(other.family, other.value), net))) {
      refuse();
    }
    const valid = net as Network;
    if (valid.family === 4) ipv4Space += sizeOf(valid);
    if (ipv4Space > MAX_TRUSTED_IPV4) refuse();
    networks.push(valid);
  }
  const list = Object.freeze(networks);
  return Object.freeze({ size: list.length, has: (address: ClientAddress): boolean => list.some((net) => within(address, net)) });
}

/**
 * The client of a request: its socket peer, or — when that peer is a trusted proxy — the first
 * untrusted hop of X-Forwarded-For walking right to left. `forwardedFor` is the header's one line
 * (a string), undefined when absent, and anything else — every line's value — when repeated.
 * Otherwise the bounded reason the client cannot be resolved.
 */
export function resolveClientAddress(peer: unknown, forwardedFor: unknown, trusted: TrustedProxies): ClientAddress | ClientAddressRefusal {
  const socketPeer = parseAddress(peer);
  if (socketPeer === null) return 'client_address_unresolvable';
  if (!trusted.has(socketPeer)) return socketPeer; // an untrusted peer's forwarding headers are never read
  if (forwardedFor === undefined) return 'forwarded_chain_missing';
  if (typeof forwardedFor !== 'string') return 'forwarded_chain_ambiguous';
  if (forwardedFor.length > MAX_FORWARDED_LENGTH) return 'forwarded_chain_too_long';
  const entries = forwardedFor.split(',');
  // inv: every entry right of the one examined is a trusted proxy.
  // term: `examined` grows by one each pass and never passes MAX_FORWARDED_HOPS.
  for (let examined = 0; examined < entries.length; examined++) {
    if (examined === MAX_FORWARDED_HOPS) return 'forwarded_chain_too_long';
    const hop = parseAddress(entries[entries.length - 1 - examined].replace(OWS_RE, ''));
    if (hop === null) return 'forwarded_chain_invalid';
    if (!trusted.has(hop)) return hop; // the first untrusted hop is the client
  }
  // Every entry is a trusted proxy: no client stands in the chain, so it is refused — never bucketed under a proxy.
  return 'forwarded_chain_invalid';
}
