/* Outbound fetch guard for widget feeds (RSS, iCal and the public APIs).
 *
 * A club Pi sits on the club's own network and can see things nobody outside
 * it can — the router's admin page, a till, a CCTV recorder. Anything that
 * fetches a URL on someone else's behalf is therefore a way to reach those
 * from outside, so every widget fetch goes through here: the address is
 * resolved first and refused if it points back at the Pi or into the club's
 * own network, and each redirect is checked again rather than followed blind.
 *
 * This is a backstop, not the fix. Widget addresses come only from the
 * dashboard (see sanitizeWidget), never from a request — that is what closes
 * the hole. This stops a configured address, or a redirect from one, being
 * pointed somewhere private.
 *
 * Note the limit honestly: the name is resolved and then handed to fetch,
 * which resolves it again. A name that answers with a public address and then
 * a private one is not caught here (DNS rebinding). Closing that needs a
 * pinned-IP connection; the addresses here all come from an admin.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 4;

/** True for anything that is not a routable public IPv4 address. */
function blockedV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // this network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a >= 224) return true; // multicast, reserved, broadcast
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  return false;
}

/** True for anything that is not a routable public IPv6 address. */
function blockedV6(ip) {
  const s = ip.toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  const mapped = /^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return blockedV4(mapped[1]);
  const first = parseInt(s.split(':')[0] || '0', 16) || 0;
  if ((first & 0xfe00) === 0xfc00) return true; // unique local
  if ((first & 0xffc0) === 0xfe80) return true; // link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when this literal address must not be fetched. Unparseable counts as blocked. */
export function blockedAddress(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  if (isIPv4(s)) return blockedV4(s);
  if (isIPv6(s)) return blockedV6(s);
  return true;
}

/**
 * Resolve `url` and throw unless every address it answers with is public.
 * A name that does not resolve is refused — better a widget that says
 * "unavailable" than a fetch we could not check.
 */
export async function assertPublicUrl(url, { lookup = dnsLookup } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Not a web address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Address not allowed: ${u.protocol} is not http or https`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Address not allowed: no host');
  if (isIPv4(host) || isIPv6(host)) {
    if (blockedAddress(host)) throw new Error(`Address not allowed: ${host} is not a public address`);
    return u;
  }
  let answers;
  try {
    answers = await lookup(host, { all: true });
  } catch (err) {
    throw new Error(`Address not allowed: could not resolve ${host} (${err.code || err.message})`);
  }
  const list = (Array.isArray(answers) ? answers : [answers]).filter(Boolean);
  if (!list.length) throw new Error(`Address not allowed: ${host} did not resolve`);
  for (const a of list) {
    const ip = typeof a === 'string' ? a : a.address;
    if (blockedAddress(ip)) throw new Error(`Address not allowed: ${host} resolves to ${ip}`);
  }
  return u;
}

/**
 * fetch() that checks the address first and re-checks every redirect, so a
 * public URL cannot bounce the Pi onto a private one.
 */
export function createSafeFetch({ fetchImpl = fetch, lookup = dnsLookup } = {}) {
  return async function safeFetch(url, init = {}) {
    let current = String(url);
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      await assertPublicUrl(current, { lookup });
      const res = await fetchImpl(current, { ...init, redirect: 'manual' });
      const status = Number(res?.status);
      const location = REDIRECTS.has(status) ? res?.headers?.get?.('location') : null;
      if (!location) return res;
      current = new URL(location, current).toString();
    }
    throw new Error('Too many redirects');
  };
}
