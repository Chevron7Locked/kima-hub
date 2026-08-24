/**
 * Narrowing helpers for headers read off an axios response and handed to Express.
 *
 * Several routes here proxy an upstream audio stream: they fetch it with axios,
 * then copy `content-length`, `content-type` and `accept-ranges` onto their own
 * response. The two libraries disagree about what a header value can be.
 *
 *   axios  `response.headers[x]`  ->  string | number | boolean | string[] | AxiosHeaders
 *   node   `res.setHeader(k, v)`  ->  string | number | readonly string[]
 *
 * axios 1.14 tightened its side of that (a valueless header is now `true`, and a
 * nested header set surfaces as an `AxiosHeaders` instance), which turned every
 * one of those copies into a type error. Rather than casting at eleven call
 * sites -- a cast silently passes `true` straight through to Node, which throws
 * `ERR_INVALID_HTTP_TOKEN` at runtime -- the conversion lives here once and is
 * total: every input shape maps to something Node accepts, or to `undefined`.
 */

/** An axios response-header value, before narrowing. */
type UpstreamHeaderValue = string | number | boolean | string[] | object | null | undefined;

/**
 * Convert an upstream header value into one Node's http layer will accept.
 *
 * Returns `undefined` when the header was absent, so callers can keep using the
 * `if (value)` / spread-when-present shape they already had. A valueless header
 * (`true`) becomes an empty string rather than being dropped: the upstream did
 * send the header, and an empty value is what Node uses to represent that.
 */
export function upstreamHeader(value: UpstreamHeaderValue): string | number | string[] | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "string" || typeof value === "number") return value;
    if (Array.isArray(value)) return value.map((entry) => String(entry));
    if (typeof value === "boolean") return value ? "" : undefined;
    // An AxiosHeaders instance, or anything else exotic: stringify rather than
    // throw. A malformed upstream header must not be able to kill the response.
    return String(value);
}

/**
 * Read an upstream header as a non-negative integer, e.g. `content-length`.
 *
 * Returns 0 for a missing, empty, non-numeric or negative value, so callers can
 * test `> 0` for "the upstream told us a real size". Never returns NaN.
 */
export function upstreamHeaderNumber(value: UpstreamHeaderValue): number {
    const narrowed = upstreamHeader(value);
    if (narrowed === undefined) return 0;
    const raw = Array.isArray(narrowed) ? narrowed[0] : narrowed;
    const parsed = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
