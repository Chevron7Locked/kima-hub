import dns from "dns";
import { lookup } from "dns/promises";
import http from "http";
import https from "https";
import net from "net";
import { logger } from "./logger";

/**
 * Addresses a fetch on behalf of a feed or a user must never reach: this machine, private and shared networks,
 * link-local (cloud metadata) and multicast. An IPv4-mapped IPv6 address (::ffff:a.b.c.d, in either spelling) is
 * matched against the IPv4 rules by BlockList itself.
 */
const BLOCKED = new net.BlockList();
for (const [range, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(range, bits, "ipv4");
for (const [range, bits] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form (::a.b.c.d)
  ["64:ff9b:1::", 48], // local-use NAT64
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(range, bits, "ipv6");

/** The eight 16-bit groups of a valid IPv6 address. */
function ipv6Groups(ip: string): number[] {
  let text = ip.split("%")[0].toLowerCase();
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - front.length - back.length).fill("0");
  return [...front, ...fill, ...back].map((g) => parseInt(g, 16));
}

/** Whether a fetch on behalf of a feed or a user may not connect to this address. Anything not an IP is refused. */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family !== 6) return true;
  // The well-known NAT64 prefix reaches the IPv4 address in its last 32 bits; judge that address.
  const g = ipv6Groups(ip);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return BLOCKED.check([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join("."), "ipv4");
  }
  return BLOCKED.check(ip, "ipv6");
}

/**
 * Validate a URL is safe to fetch server-side (no SSRF risk).
 * Returns null if safe, or an error string if blocked.
 */
export async function validateUrlForFetch(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }

  // Only allow http/https schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked scheme: ${parsed.protocol}`;
  }

  // An address written as the host is judged as it stands; a name is resolved first.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (!isBlockedIp(hostname)) return null;
    logger.warn(`[SSRF] Blocked fetch to ${hostname}`);
    return "Blocked: internal address";
  }

  // Block obvious internal hostnames
  if (hostname === "localhost" || hostname === "0.0.0.0") {
    return "Blocked hostname: localhost";
  }

  try {
    const { address } = await lookup(hostname);
    if (isBlockedIp(address)) {
      logger.warn(`[SSRF] Blocked fetch to ${hostname} (resolved to ${address})`);
      return `Blocked: internal address`;
    }
  } catch {
    // DNS resolution failed -- could be a non-existent host
    return "DNS resolution failed";
  }

  return null;
}

/** A fetch refused because an address it would reach is internal. */
export class BlockedAddressError extends Error {
  name = "BlockedAddressError";
}

/** Whether a fetch failed because the guard refused an address, however the HTTP client wrapped the refusal. */
export function isBlockedFetch(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof BlockedAddressError) return true;
  }
  return false;
}

/** A name lookup that refuses internal addresses, so a connection can never reach one whatever led to it. */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const answers = Array.isArray(address) ? address : [{ address, family }];
    const internal = answers.find((a) => isBlockedIp(a.address));
    if (internal) {
      logger.warn(`[SSRF] Refused a connection to ${hostname} (${internal.address})`);
      return callback(new BlockedAddressError(`Blocked: ${hostname} is an internal address`), address, family);
    }
    callback(null, address, family);
  });
};

/**
 * axios options for an address that came from a feed or a user, where validateUrlForFetch checks only the first.
 * Every connection's address is checked, on each redirect too and after a name changes its answer; a redirect
 * straight to an internal IP is refused before connecting, since an IP needs no lookup.
 */
export const guardedAxios = {
  httpAgent: new http.Agent({ lookup: guardedLookup }),
  httpsAgent: new https.Agent({ lookup: guardedLookup }),
  beforeRedirect: (options: { hostname?: string }) => {
    const host = (options.hostname ?? "").replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isBlockedIp(host)) throw new BlockedAddressError(`Blocked: redirect to internal address ${host}`);
  },
};

/**
 * Node's fetch for an address that came from a feed, a user or a metadata source: follows up to five redirects
 * itself and checks each address first; past five, the last redirect is the answer (not ok, so callers treat it as
 * a failed fetch). Unlike guardedAxios it cannot check the connection itself.
 */
export async function fetchChecked(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const blocked = await validateUrlForFetch(current);
    if (blocked) throw new BlockedAddressError(`Blocked: ${blocked}`);
    const response = await fetch(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    if (hop >= maxRedirects) return response;
    await response.body?.cancel();
    current = new URL(location, current).toString();
  }
}
