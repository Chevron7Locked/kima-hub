/**
 * The answer to a question asked of an external source (MusicBrainz,
 * AcoustID, ListenBrainz, Deezer, …). One of five kinds, always: a failed
 * call is never allowed to look like "the source has nothing".
 */

type OutcomeError = {
    /** Stable machine code, e.g. "TIMEOUT", "HTTP_500", "MALFORMED". */
    code: string;
    /** Human-readable cause, from the real error — never a stand-in. */
    message: string;
};

export type Outcome<T> =
    /** The source answered with data. `evidence` cites the call. */
    | { kind: "answered"; value: T; evidence: Record<string, unknown> }
    /** The source answered and genuinely has nothing for this question. */
    | { kind: "absent"; evidence: Record<string, unknown> }
    /** The source rate-limited us; `retryAfter` is when it may be asked again. */
    | { kind: "rateLimited"; retryAfter: Date; evidence: Record<string, unknown> }
    /** A failure that may succeed if asked again (5xx, timeout, network). */
    | { kind: "transient"; error: OutcomeError }
    /** A failure that will not change (bad query, missing key, 4xx). */
    | { kind: "permanent"; error: OutcomeError };

export function answered<T>(
    value: T,
    evidence: Record<string, unknown> = {},
): Outcome<T> {
    return { kind: "answered", value, evidence };
}

export function absent(evidence: Record<string, unknown> = {}): Outcome<never> {
    return { kind: "absent", evidence };
}

export function rateLimited(
    retryAfter: Date,
    evidence: Record<string, unknown> = {},
): Outcome<never> {
    return { kind: "rateLimited", retryAfter, evidence };
}

export function transient(code: string, message: string): Outcome<never> {
    return { kind: "transient", error: { code, message } };
}

export function permanent(code: string, message: string): Outcome<never> {
    return { kind: "permanent", error: { code, message } };
}

export type Failure = Extract<
    Outcome<unknown>,
    { kind: "rateLimited" | "transient" | "permanent" }
>;

export function failureCause(o: Failure): string {
    return o.kind === "rateLimited"
        ? `rate-limited until ${o.retryAfter.toISOString()}`
        : `${o.error.code}: ${o.error.message}`;
}
