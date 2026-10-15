import dns from "dns";
import { lookup } from "dns/promises";
import http from "http";
import https from "https";
import net from "net";
import { logger } from "./logger";

/**
 * Private/internal IP ranges that must not be accessed via server-side fetch.
 * Prevents SSRF attacks where authenticated users could probe internal networks.
 */
const BLOCKED_PREFIXES = [
  "127.",          // Loopback
  "10.",           // RFC 1918
  "192.168.",      // RFC 1918
  "169.254.",      // Link-local / cloud metadata
  "0.",            // Current network
  "::ffff:127.",   // IPv4-mapped loopback
  "::ffff:10.",    // IPv4-mapped private
  "::ffff:192.168.", // IPv4-mapped private
  "::ffff:169.254.", // IPv4-mapped link-local
];

function isBlockedIp(ip: string): boolean {
  if (ip === "0.0.0.0" || ip === "::" || ip === "::1") return true;
  for (const prefix of BLOCKED_PREFIXES) {
    if (ip.startsWith(prefix)) return true;
  }
  // 172.16.0.0/12
  if (ip.startsWith("172.") || ip.startsWith("::ffff:172.")) {
    const raw = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
    const second = parseInt(raw.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
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

  // Resolve hostname to IP and check against blocked ranges
  const hostname = parsed.hostname;

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
 * Node's fetch for an address that came from a feed or a user: follows up to five redirects itself and checks
 * each address first. Unlike guardedAxios it cannot check the connection itself.
 */
export async function fetchChecked(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const blocked = await validateUrlForFetch(current);
    if (blocked) throw new BlockedAddressError(`Blocked: ${blocked}`);
    const response = await fetch(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel();
    if (hop >= maxRedirects) throw new Error("Too many redirects");
    current = new URL(location, current).toString();
  }
}
