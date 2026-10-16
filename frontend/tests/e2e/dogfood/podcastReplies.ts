import type { APIResponse } from "@playwright/test";

/**
 * The answers Kima's podcast routes give when a service outside Kima failed: Apple's directory or a show's feed did
 * not answer (502), Apple has no such chart or show, Apple does not know the show, nothing is at the feed address
 * (404 with those exact messages), or the feed could not be read (422). Any other failure is Kima's own.
 */
const OUTSIDE_FAILURES: Array<{ status: number; error?: string }> = [
    { status: 502 },
    { status: 404, error: "Apple Podcasts has no such chart or show" },
    { status: 404, error: "Podcast not found in iTunes" },
    { status: 404, error: "Nothing was found at that feed address" },
    { status: 422, error: "Podcast feed could not be read" },
];

/**
 * Null when the reply succeeded; why, when a service outside Kima failed (for the caller to record as not covered).
 * Throws with the reply when the failure is Kima's own, so it fails the run.
 */
export async function outsideFailure(res: APIResponse, what: string): Promise<string | null> {
    if (res.ok()) return null;
    const text = await res.text();
    let error: unknown;
    try {
        error = JSON.parse(text)?.error;
    } catch {
        error = undefined;
    }
    if (OUTSIDE_FAILURES.some((f) => f.status === res.status() && (f.error === undefined || f.error === error))) {
        return `${what} answered ${res.status()}${typeof error === "string" ? ` (${error})` : ""}`;
    }
    throw new Error(`${what} answered ${res.status()}: ${text.slice(0, 300)}`);
}
