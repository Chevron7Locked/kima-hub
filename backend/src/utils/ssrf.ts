import dns from "dns";
import { lookup } from "dns/promises";
import http from "http";
import https from "https";
import net from "net";
import type { Duplex } from "stream";
import { Agent } from "undici";
import { logger } from "./logger";
import { errorChain } from "./errorChain";

/**
 * Addresses a fetch on behalf of a feed or a user must never reach: this machine, private and shared networks,
 * link-local (cloud metadata) and multicast. An IPv4-mapped IPv6 address (::ffff:a.b.c.d, in either spelling) is
 * matched against the IPv4 rules by BlockList itself.
 */
const BLOCKED = new net.BlockList();
for (const [range, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(range, bits, "ipv4");
for (const [range, bits] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form (::a.b.c.d)
  ["64:ff9b:1::", 48], // local-use NAT64
  ["2001::", 32], // Teredo, whose IPv4 endpoints are hidden in the address
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
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
  // Forms that carry an IPv4 address reach that address, so it is the one judged: the well-known NAT64 prefix and
  // the IPv4-translated form (::ffff:0:a.b.c.d) in their last 32 bits, 6to4 (2002::/16) in the 32 after the prefix.
  const g = ipv6Groups(ip);
  const v4 = (hi: number, lo: number) => BLOCKED.check([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."), "ipv4");
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]);
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return BLOCKED.check(ip, "ipv6");
}

/**
 * What a fetch may make of an address before connecting: fine; refused (an internal address, or not a web address);
 * not an address at all; or a name that does not resolve, which is a failed fetch, not a refusal.
 */
type AddressCheck = { ok: true } | { ok: false; kind: "blocked" | "invalid" | "unresolved"; reason: string };

async function checkAddress(url: string): Promise<AddressCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, kind: "invalid", reason: "Invalid URL" };
  }

  // Only allow http/https schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, kind: "blocked", reason: `Blocked scheme: ${parsed.protocol}` };
  }

  // An address written as the host is judged as it stands; a name is resolved first.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (!isBlockedIp(hostname)) return { ok: true };
    logger.warn(`[SSRF] Blocked fetch to ${hostname}`);
    return { ok: false, kind: "blocked", reason: "Blocked: internal address" };
  }

  // This machine by name ("0.0.0.0" and the like are IPs, judged above).
  if (hostname === "localhost") {
    return { ok: false, kind: "blocked", reason: "Blocked hostname: localhost" };
  }

  try {
    const { address } = await lookup(hostname);
    if (isBlockedIp(address)) {
      logger.warn(`[SSRF] Blocked fetch to ${hostname} (resolved to ${address})`);
      return { ok: false, kind: "blocked", reason: "Blocked: internal address" };
    }
  } catch {
    return { ok: false, kind: "unresolved", reason: `DNS resolution failed for ${hostname}` };
  }

  return { ok: true };
}

/**
 * Validate a URL is safe to fetch server-side (no SSRF risk).
 * Returns null if safe, or why not (refused, not an address, or a name that does not resolve).
 */
export async function validateUrlForFetch(url: string): Promise<string | null> {
  const check = await checkAddress(url);
  return check.ok ? null : check.reason;
}

/** A fetch refused because an address it would reach is internal, or is not a web address. */
export class BlockedAddressError extends Error {
  name = "BlockedAddressError";
}

/** A fetch given something that is not an address. */
export class InvalidAddressError extends Error {
  name = "InvalidAddressError";
}

/** A fetch whose host name does not resolve: the upstream cannot be reached, nothing was refused. */
export class UnresolvedAddressError extends Error {
  name = "UnresolvedAddressError";
}

/**
 * Whether a fetch failed because the guard refused an address, however the HTTP client wrapped the refusal: axios
 * keeps the error as a cause; undici (Node's fetch) re-creates it as a plain error named by its message.
 */
export function isBlockedFetch(error: unknown): boolean {
  for (const e of errorChain(error)) {
    if (e instanceof BlockedAddressError) return true;
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message.startsWith("BlockedAddressError: ")) return true;
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
 * Refuses a connection to an internal address written as the host itself: an IP needs no name lookup, so
 * guardedLookup never sees it.
 */
function refuseInternalIp(host: string | null | undefined): BlockedAddressError | null {
  const ip = (host ?? "").replace(/^\[|\]$/g, "");
  if (!net.isIP(ip) || !isBlockedIp(ip)) return null;
  logger.warn(`[SSRF] Refused a connection to ${ip}`);
  return new BlockedAddressError(`Blocked: ${ip} is an internal address`);
}

/** An http or https agent that refuses, before connecting, a host written as an internal IP. */
function refusingInternalIps<T extends new (...args: any[]) => http.Agent>(Base: T) {
  return class extends Base {
    createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
      const refused = refuseInternalIp(options.host);
      if (refused) {
        callback?.(refused, undefined as unknown as Duplex);
        return undefined;
      }
      return super.createConnection(options, callback);
    }
  };
}

const GuardedHttpAgent = refusingInternalIps(http.Agent);
const GuardedHttpsAgent = refusingInternalIps(https.Agent);

/**
 * axios options for an address that came from a feed or a user. Every connection's address is checked as it is
 * made, the first one and each redirect's: a name through guardedLookup, also after it changes its answer; an IP
 * written as the host before connecting.
 */
export const guardedAxios = {
  httpAgent: new GuardedHttpAgent({ lookup: guardedLookup }),
  httpsAgent: new GuardedHttpsAgent({ lookup: guardedLookup }),
};

/** Node's fetch connecting only through guardedLookup, so a name that answers differently after the check is refused. */
const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup } });

/**
 * Node's fetch for an address that came from a feed, a user or a metadata source: follows up to five redirects
 * itself and checks each address first, and every connection's address is checked again as it is made; past five
 * redirects, the last redirect is the answer (not ok, so callers treat it as a failed fetch).
 */
export async function fetchChecked(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const check = await checkAddress(current);
    if (!check.ok) {
      if (check.kind === "blocked") throw new BlockedAddressError(check.reason);
      if (check.kind === "invalid") throw new InvalidAddressError(check.reason);
      throw new UnresolvedAddressError(check.reason);
    }
    let response: Response;
    try {
      response = await fetch(current, { ...init, redirect: "manual", dispatcher: guardedDispatcher } as unknown as RequestInit);
    } catch (error) {
      if (isBlockedFetch(error)) throw new BlockedAddressError(`Blocked: ${new URL(current).hostname} is an internal address`);
      throw error;
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    if (hop >= maxRedirects) return response;
    await response.body?.cancel();
    current = new URL(location, current).toString();
  }
}
