import axios from "axios";
import { isBlockedFetch, UnresolvedAddressError } from "./ssrf";
import { TimeoutError } from "./timeout";
import { errorChain } from "./errorChain";

/** An upstream answered, but not with what was asked for (an error page, a garbled or empty reply). */
export class UpstreamReplyError extends Error {
    name = "UpstreamReplyError";
}

/**
 * Node's fetch failing to reach the host (it rejects with a TypeError "fetch failed" naming the cause), or its
 * time limit running out; or a host name that does not resolve.
 */
function unreachedByFetch(e: unknown): boolean {
    return (
        e instanceof UnresolvedAddressError ||
        (e instanceof TypeError && e.message === "fetch failed") ||
        (e instanceof Error && e.name === "TimeoutError" && !(e instanceof TimeoutError))
    );
}

/**
 * How an upstream's failure (Apple, a feed's host, a preview's host) is answered, never as Kima's own 500:
 * - "missing": the address guard refused it, or the upstream's 4xx says it has no such thing (gone, forbidden, an
 *   expired link) — 429 is not one of those, it only says "not now";
 * - "down": throttled, an outage, a timeout, a host that cannot be reached, or a reply that is not what was asked for;
 * - null: not an upstream failure.
 */
/** What an upstream's own HTTP status says: a 4xx (bar 429) means it has no such thing; a 429 or 5xx, try later. */
export function upstreamStatusFailure(status: number): "missing" | "down" {
    return status >= 400 && status < 500 && status !== 429 ? "missing" : "down";
}

export function upstreamFailure(error: unknown): "missing" | "down" | null {
    if (isBlockedFetch(error)) return "missing";
    let upstream = false;
    for (const e of errorChain(error)) {
        if (axios.isAxiosError(e)) {
            const status = e.response?.status;
            if (status && upstreamStatusFailure(status) === "missing") return "missing";
            upstream = true;
        } else if (e instanceof UpstreamReplyError || e instanceof TimeoutError || unreachedByFetch(e)) {
            upstream = true;
        }
    }
    return upstream ? "down" : null;
}

/** Whether the upstream never gave a usable answer at all: unreachable, timed out, throttled or a 5xx. */
export function upstreamUnreachable(error: unknown): boolean {
    for (const e of errorChain(error)) {
        if (e instanceof TimeoutError || unreachedByFetch(e)) return true;
        if (axios.isAxiosError(e)) {
            const status = e.response?.status;
            return !status || status >= 500 || status === 429;
        }
    }
    return false;
}
