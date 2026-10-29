/** The wire shape of GET /api/stats. `system` is absent for non-admins. */

export interface ListeningStats {
    plays: number;
    /** Derived from track length, never measured. Always shown as "about". */
    estimatedSeconds: number;
    distinctTracks: number;
    distinctArtists: number;
    distinctAlbums: number;
    firstPlay: string | null;
    lastPlay: string | null;
    bySource: Record<string, number>;
    /** [weekday 0=Sunday][hour 0-23], in the viewer's own timezone. */
    clock: number[][];
    peak: { weekday: number; hour: number; plays: number } | null;
    /** Valence on x, energy on y, both bucketed 1..24. */
    shape: Array<{ x: number; y: number; plays: number }>;
    drift: Array<{
        month: string;
        energy: number | null;
        valence: number | null;
        bpm: number | null;
        plays: number;
    }>;
    topArtists: Array<{ id: string; name: string; plays: number; estimatedSeconds: number }>;
    topTracks: Array<{ id: string; title: string; artist: string; plays: number }>;
}

export interface ShelfStats {
    tracks: { total: number; heard: number };
    albums: { total: number; heard: number };
    artists: { total: number; heard: number };
    analysis: { done: number; pending: number; failed: number; total: number };
    neverPlayed: number;
    decades: Array<{ decade: number; albums: number; heard: number }>;
}

export interface SpokenStats {
    audiobooks: {
        seconds: number;
        finished: number;
        inProgress: number;
        setAside: number;
        topAuthors: Array<{ name: string; seconds: number }>;
        current: { title: string; author: string | null; percent: number } | null;
    };
    podcasts: {
        seconds: number;
        finished: number;
        inProgress: number;
        subscriptions: number;
        backlog: number;
    };
}

export interface SystemStats {
    version: string;
    uptimeSeconds: number;
    db: number | null;
    redis: number | null;
    jobs: Array<{ status: string; count: number }>;
    corruptTracks: number;
    enrichmentFailures: number;
    library: { tracks: number; albums: number; artists: number; bytes: number };
    cache: { transcodedMb: number };
}

export interface Signature {
    concentration: { forHalf: number; forEighty: number; distinct: number } | null;
    albumHabit: { moves: number; sameAlbumPct: number; inOrderPct: number } | null;
    era: {
        medianYear: number;
        buckets: Array<{ label: string; plays: number; percent: number }>;
    } | null;
    key: {
        minorPct: number;
        top: Array<{ key: string; plays: number }>;
        /** Every key played, for the wheel. `key` is the pitch, e.g. "F#". */
        all: Array<{ key: string; scale: "major" | "minor"; plays: number }>;
    } | null;
    ownedVsPlayed: Array<{ label: string; owned: number; played: number; unit: "ratio" | "bpm" }>;
    /** The same, hour by hour, for a curve rather than four bars. */
    hourly: Array<{ hour: number; plays: number; energy: number }>;
}

/** Rolling windows, so early in a month or week there is no near-empty cliff. */
export type Period = "30d" | "12mo" | "all";

export const PERIODS: Array<{ id: Period; label: string; sentence: string }> = [
    { id: "30d", label: "30 days", sentence: "· last 30 days" },
    { id: "12mo", label: "12 months", sentence: "· last 12 months" },
    { id: "all", label: "all time", sentence: "" },
];

export interface StatsResponse {
    /** Echoed back by the server, so the page renders the window it was given. */
    period: Period;
    listening: ListeningStats;
    shelf: ShelfStats;
    spoken: SpokenStats;
    /** The figures that need owning the files and having analysed them. */
    signature: Signature;
    /** Admins only. Absent, not empty, for everyone else. */
    system?: SystemStats;
}
