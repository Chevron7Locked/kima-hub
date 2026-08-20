/**
 * Data readiness gate for the dogfood walkthrough.
 *
 * The rest of the suite calls test.skip() when the library is empty, which is the right
 * call for a feature test -- there is no album page to check if there are no albums. It is
 * the wrong call for a deployment gate. A suite that skips its way to green has tested
 * nothing and reports the same colour as a suite that passed, which is precisely the signal
 * you must not send just before a deploy.
 *
 * So this gate fails instead of skipping, and it fails with an explanation of what is
 * missing and how to supply it. "Not enough data to test this build" is a real answer. A
 * green tick over an untested build is not.
 */
import { APIRequestContext, expect } from "@playwright/test";

export interface LibraryFacts {
    albums: number;
    artists: number;
    tracks: number;
    playlists: number;
    /** Tracks carrying analyzer output (bpm/key/energy) -- proves the pipeline ran. */
    tracksWithAudioFeatures: number;
    /** Tracks with a CLAP embedding, which is what the vibe map is built from. */
    embeddedTracks: number;
    podcasts: number;
    audiobooks: number;
}

/** What the walkthrough needs before it is worth running at all. */
const MINIMUMS = {
    albums: 2,
    artists: 2,
    tracks: 10,
} as const;

async function getJson<T>(
    api: APIRequestContext,
    url: string,
    token: string,
): Promise<T | null> {
    const res = await api.get(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok()) return null;
    return (await res.json()) as T;
}

/**
 * Read what is actually in this instance.
 *
 * Everything is best-effort except the three counts the walkthrough cannot proceed without.
 * A missing podcast feed means the podcast journey is skipped with a reason recorded; a
 * missing library means the run stops.
 */
export async function readLibraryFacts(
    api: APIRequestContext,
    token: string,
): Promise<LibraryFacts> {
    const [albums, artists, tracks, playlists, podcasts, audiobooks] = await Promise.all([
        getJson<{ total: number }>(api, "/api/library/albums?limit=1", token),
        getJson<{ total: number }>(api, "/api/library/artists?limit=1", token),
        getJson<{ total: number }>(api, "/api/library/tracks?limit=1", token),
        getJson<unknown>(api, "/api/playlists", token),
        getJson<unknown>(api, "/api/podcasts", token),
        getJson<unknown>(api, "/api/audiobooks", token),
    ]);

    // A sample large enough to tell "the analyzer ran" from "the analyzer ran on one track".
    const sample = await getJson<{
        tracks: Array<{ audioFeatures?: { bpm?: number | null } | null }>;
    }>(api, "/api/library/tracks?limit=50", token);

    const withFeatures =
        sample?.tracks?.filter((t) => t.audioFeatures && t.audioFeatures.bpm != null).length ?? 0;

    // The vibe map is the user-visible end of the embedding pipeline. Ask it directly
    // rather than counting rows, because what matters is whether the map has anything to
    // draw, not what the database holds.
    const vibeMap = await getJson<{ tracks?: unknown[] }>(api, "/api/vibe/map", token);

    const countOf = (v: unknown): number => {
        if (Array.isArray(v)) return v.length;
        if (v && typeof v === "object") {
            for (const key of ["total", "count"]) {
                const n = (v as Record<string, unknown>)[key];
                if (typeof n === "number") return n;
            }
            for (const val of Object.values(v as Record<string, unknown>)) {
                if (Array.isArray(val)) return val.length;
            }
        }
        return 0;
    };

    return {
        albums: albums?.total ?? 0,
        artists: artists?.total ?? 0,
        tracks: tracks?.total ?? 0,
        playlists: countOf(playlists),
        tracksWithAudioFeatures: withFeatures,
        embeddedTracks: countOf(vibeMap),
        podcasts: countOf(podcasts),
        audiobooks: countOf(audiobooks),
    };
}

/**
 * Stop the run if this instance cannot support a meaningful walkthrough.
 *
 * Deliberately hard. The point of a pre-deployment gate is to be the thing that says no.
 */
export function assertReady(facts: LibraryFacts, baseUrl: string): void {
    const missing: string[] = [];
    if (facts.albums < MINIMUMS.albums) {
        missing.push(`albums: found ${facts.albums}, need at least ${MINIMUMS.albums}`);
    }
    if (facts.artists < MINIMUMS.artists) {
        missing.push(`artists: found ${facts.artists}, need at least ${MINIMUMS.artists}`);
    }
    if (facts.tracks < MINIMUMS.tracks) {
        missing.push(`tracks: found ${facts.tracks}, need at least ${MINIMUMS.tracks}`);
    }

    expect(
        missing,
        `The instance at ${baseUrl} does not hold enough music to test this build.\n\n` +
            missing.map((m) => `  - ${m}`).join("\n") +
            `\n\nThis is a failure, not a skip: a walkthrough that quietly tests nothing is\n` +
            `worse than no walkthrough, because it reports the same green as a real pass.\n` +
            `Point KIMA_UI_BASE_URL at an instance with a scanned library, or scan one here.`,
    ).toHaveLength(0);
}

/**
 * Which optional journeys this instance can support.
 *
 * These are recorded rather than asserted. A test stack with no podcast feeds is a normal
 * state, and the report says so out loud so nobody mistakes an unexercised journey for a
 * passing one.
 */
export function availableJourneys(facts: LibraryFacts): {
    vibe: boolean;
    podcasts: boolean;
    audiobooks: boolean;
    reasons: string[];
} {
    const reasons: string[] = [];

    const vibe = facts.embeddedTracks >= 5;
    if (!vibe) {
        reasons.push(
            `vibe journey not run: the map holds ${facts.embeddedTracks} tracks, needs 5+ ` +
                `(run the enrichment cycle to build embeddings)`,
        );
    }

    const podcasts = facts.podcasts > 0;
    if (!podcasts) reasons.push("podcast journey not run: no podcast subscriptions on this instance");

    const audiobooks = facts.audiobooks > 0;
    if (!audiobooks) reasons.push("audiobook journey not run: no audiobooks on this instance");

    if (facts.tracksWithAudioFeatures === 0) {
        reasons.push(
            "no analyzer output found in a 50-track sample: bpm/key/energy are absent, so " +
                "anything downstream of audio analysis is untested",
        );
    }

    return { vibe, podcasts, audiobooks, reasons };
}
