import axios from "axios";
import { isBlockedFetch } from "./ssrf";
import { TimeoutError } from "./timeout";

/** An upstream answered, but not with what was asked for (an error page, a garbled or empty reply). */
export class UpstreamReplyError extends Error {
    name = "UpstreamReplyError";
}

/** The error and what it wraps, outermost first. */
function* chain(error: unknown): Generator<unknown> {
    for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) yield e;
}

/**
 * How an upstream's failure (Apple, a feed's host, a preview's host) is answered, never as Kima's own 500:
 * - "missing": the address guard refused it, or the upstream's 4xx says it has no such thing (gone, forbidden, an
 *   expired link) — 429 is not one of those, it only says "not now";
 * - "down": throttled, an outage, a timeout, or a reply that is not what was asked for;
 * - null: not an upstream failure.
 */
export function upstreamFailure(error: unknown): "missing" | "down" | null {
    if (isBlockedFetch(error)) return "missing";
    let upstream = false;
    for (const e of chain(error)) {
        if (axios.isAxiosError(e)) {
            const status = e.response?.status;
            if (status && status >= 400 && status < 500 && status !== 429) return "missing";
            upstream = true;
        } else if (e instanceof UpstreamReplyError || e instanceof TimeoutError) {
            upstream = true;
        }
    }
    return upstream ? "down" : null;
}

/** Whether the upstream never gave a usable answer at all: unreachable, timed out, throttled or a 5xx. */
export function upstreamUnreachable(error: unknown): boolean {
    for (const e of chain(error)) {
        if (e instanceof TimeoutError) return true;
        if (axios.isAxiosError(e)) {
            const status = e.response?.status;
            return !status || status >= 500 || status === 429;
        }
    }
    return false;
}
