import type { APIRequestContext, APIResponse } from "@playwright/test";

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

/** What `pickUnfollowedShow` found: a show to follow, or why there is none. */
export type ShowPick = { show: { itunesId: string; title: string } } | { none: string };

/**
 * The first show on Apple's top chart that the signed-in user does not follow yet, so a journey that
 * follows and then unfollows never removes a show the listener had before. Asks the server's preview
 * of each of the first 20 chart shows whether it is followed.
 */
export async function pickUnfollowedShow(
    api: Pick<APIRequestContext, "get">,
    token: string,
): Promise<ShowPick> {
    const headers = { Authorization: `Bearer ${token}` };
    const charts = await api.get("/api/podcasts/charts?limit=20", { headers });
    const chartBlocked = await outsideFailure(charts, "the podcast chart");
    if (chartBlocked) return { none: chartBlocked };
    const body = await charts.json();
    const list = (Array.isArray(body) ? body : (body.podcasts ?? [])) as Array<{ itunesId?: number | string; title?: string }>;
    const offered = list.filter((p) => p.itunesId != null);
    if (offered.length === 0) return { none: "the podcast directory returned nothing to follow" };
    for (const p of offered) {
        const itunesId = String(p.itunesId);
        const preview = await api.get(`/api/podcasts/preview/${itunesId}`, { headers });
        const previewBlocked = await outsideFailure(preview, `the preview of show ${itunesId}`);
        if (previewBlocked) continue;
        if ((await preview.json()).isSubscribed === false) return { show: { itunesId, title: p.title ?? "" } };
    }
    return { none: `the user already follows all ${offered.length} top chart shows that could be checked` };
}
