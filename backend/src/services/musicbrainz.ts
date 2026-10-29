import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { INTERACTIVE_PRIORITY, rateLimiter } from "./rateLimiter";
import { sourcePauseController } from "./sourcePauseController";
import {
    Outcome,
    answered,
    absent,
    rateLimited,
    permanent,
} from "../utils/outcome";
import { USER_AGENT } from "../config";
import {
    normalizeIsrc,
    pickRecording,
    recordingAgrees,
    type CandidateRecording,
    type ExpectedRecording,
} from "./recordingMatch";

/** Every name an artist credit gives: each credited name as written, the artist's own and sort names, and
 * the whole credit as one line ("Hall & Oates"). */
function creditNames(credit: any[] | undefined): string[] {
    const parts = credit ?? [];
    const names = [
        ...parts.flatMap((c) => [c?.name, c?.artist?.name, c?.artist?.["sort-name"]]),
        parts.map((c) => `${c?.name ?? ""}${c?.joinphrase ?? ""}`).join("").trim(),
    ];
    return [...new Set(names.filter((n): n is string => typeof n === "string" && n !== ""))];
}

/** Curated genres or crowd tags with their vote counts, as MusicBrainz lists them. */
function voteCounts(entries: any[] | undefined): Array<{ name: string; count: number }> {
    return (entries ?? []).filter((e) => e.count > 0).map((e) => ({ name: e.name, count: e.count }));
}

/** The release that stands for its release group: official first, then the earliest (a date of only a year
 * or a month sorts after the full dates within it; undated last), then by id, so the choice never varies. */
function chooseRelease<T extends { id: string; status?: string; date?: string }>(releases: T[]): T {
    const sortableDate = (date: string | undefined) => `${date || "9999"}-99-99`.slice(0, 10);
    return [...releases].sort((a, b) => {
        const official = Number(b.status === "Official") - Number(a.status === "Official");
        if (official !== 0) return official;
        return sortableDate(a.date).localeCompare(sortableDate(b.date)) || String(a.id).localeCompare(String(b.id));
    })[0];
}

/** A MusicBrainz disambiguation that marks another version of a song: live, a demo, acoustic, a remix, or a
 * dated performance. */
function isOtherVersion(disambiguation: string | undefined): boolean {
    const text = (disambiguation ?? "").toLowerCase();
    return /\b(live|demo|acoustic|remix)\b/.test(text) || /\d{4}[-‐]\d{2}[-‐]\d{2}/.test(text);
}

type RecordingGenres = { genres: Array<{ name: string; count: number }>; tags: Array<{ name: string; count: number }> };

function toCandidate(rec: any): CandidateRecording {
    return {
        id: rec.id,
        title: rec.title ?? "",
        lengthMs: typeof rec.length === "number" ? rec.length : null,
        artists: creditNames(rec["artist-credit"]),
        score: typeof rec.score === "number" ? rec.score : undefined,
    };
}

const ANSWERED_TTL = 30 * 24 * 3600;
const ABSENT_TTL = 7 * 24 * 3600;

/** One release of an album group with its tracklist: what `getAlbumCatalogue` answers. */
export interface AlbumCatalogue {
    releaseMbid: string;
    originalYear: number | null;
    label: string | null;
    genres: { name: string; count: number }[];
    recordings: Array<{
        recordingId: string;
        title: string;
        position: number | null;
        durationMs: number | null;
        isrcs: string[];
        genres: { name: string; count: number }[];
        /** Every name the track is credited to (`creditNames`). */
        artists: string[];
    }>;
}

interface CacheEnvelope {
    __outcome: "answered" | "absent";
    value?: unknown;
    evidence?: Record<string, unknown>;
    savedAt?: string;
}

/**
 * MusicBrainz Web Service v2 client. Every method returns an `Outcome`, so a
 * failed or rate-limited call is never mistaken for "the source has nothing".
 * `answered` is cached 30 days and `absent` 7; failures are never cached.
 */
class MusicBrainzService {
    private client: AxiosInstance;
    /** Album tracklist fetches under way, so songs of one album asked at once share one fetch. */
    private tracklistsInFlight = new Map<string, Promise<Outcome<AlbumCatalogue>>>();

    constructor() {
        this.client = axios.create({
            baseURL: process.env.MUSICBRAINZ_BASE_URL || "https://musicbrainz.org/ws/2",
            timeout: 10000,
            headers: {
                "User-Agent": USER_AGENT,
            },
        });
    }

    /**
     * Every HTTP call goes through the rate limiter so that methods making
     * several calls (searchRecording, identifyRecording) cannot exceed the
     * 1 req/s limit.
     */
    private async rateLimitedGet(
        url: string,
        config?: any,
        priority = 0
    ): Promise<any> {
        return rateLimiter.execute("musicbrainz", () => this.client.get(url, config), {
            priority,
        });
    }

    /**
     * Classify a source error: a rate limit extends the MusicBrainz pause
     * (`rateLimited`), a 404 on a lookup is `absent`, other 4xx except timeouts
     * are `permanent`, and 5xx or transport errors are `transient`.
     */
    private async classifyError(
        err: any,
        notFoundMeansAbsent: boolean
    ): Promise<Outcome<never>> {
        if (await sourcePauseController.handleRateLimit("musicbrainz", err)) {
            const pause = await sourcePauseController.getPause("musicbrainz");
            return rateLimited(
                pause?.until ?? new Date(Date.now() + 30_000),
                { reason: "rate-limited", detail: String(err?.message ?? err) }
            );
        }
        const status = err?.response?.status;
        if (status === 404 && notFoundMeansAbsent) {
            return absent({ status: 404 });
        }
        const code =
            status !== undefined
                ? `HTTP_${status}`
                : err?.code === "ECONNABORTED"
                  ? "TIMEOUT"
                  : "NETWORK";
        if (
            status !== undefined &&
            status >= 400 &&
            status < 500 &&
            status !== 408
        ) {
            return permanent(code, String(err?.message ?? err));
        }
        return {
            kind: "transient",
            error: { code, message: String(err?.message ?? err) },
        };
    }

    private async cachedOutcome<T>(
        cacheKey: string,
        fetch: () => Promise<Outcome<T>>
    ): Promise<Outcome<T>> {
        const cached = await this.readCached<T>(cacheKey);
        if (cached) return cached;
        const outcome = await fetch();
        await this.writeCached(cacheKey, outcome);
        return outcome;
    }

    /** A cached answer or "nothing there", or null when the source must be asked. */
    private async readCached<T>(cacheKey: string): Promise<Outcome<T> | null> {
        try {
            const raw = await redisClient.get(cacheKey);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw) as CacheEnvelope;
                    if (parsed?.__outcome === "answered") {
                        return {
                            kind: "answered",
                            value: parsed.value as T,
                            evidence: {
                                ...parsed.evidence,
                                cached: true,
                                cachedAt: parsed.savedAt,
                            },
                        };
                    }
                    if (parsed?.__outcome === "absent") {
                        return {
                            kind: "absent",
                            evidence: {
                                ...parsed.evidence,
                                cached: true,
                                cachedAt: parsed.savedAt,
                            },
                        };
                    }
                } catch {
                    // unparseable cache value
                }
                // Not an Outcome envelope: drop it and ask the source again.
                await redisClient.del(cacheKey);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }
        return null;
    }

    /** Answers and "nothing there" are kept; failures are not, so the next caller asks again. */
    private async writeCached<T>(cacheKey: string, outcome: Outcome<T>): Promise<void> {
        if (outcome.kind === "answered") {
            const envelope: CacheEnvelope = {
                __outcome: "answered",
                value: outcome.value,
                evidence: outcome.evidence,
                savedAt: new Date().toISOString(),
            };
            await this.cacheWrite(cacheKey, ANSWERED_TTL, envelope);
        } else if (outcome.kind === "absent") {
            const envelope: CacheEnvelope = {
                __outcome: "absent",
                evidence: outcome.evidence,
                savedAt: new Date().toISOString(),
            };
            await this.cacheWrite(cacheKey, ABSENT_TTL, envelope);
        }
    }

    /**
     * A failed cache write never un-answers the source: the envelope is
     * for the next caller, and the caller in front of us already has the
     * real answer.
     */
    private async cacheWrite(
        cacheKey: string,
        ttlSeconds: number,
        envelope: CacheEnvelope
    ): Promise<void> {
        try {
            await redisClient.setex(cacheKey, ttlSeconds, JSON.stringify(envelope));
        } catch (err) {
            logger.warn(`Redis cache write failed for ${cacheKey}:`, err);
        }
    }

    async searchArtist(
        query: string,
        limit = 10,
        opts: { interactive?: boolean } = {}
    ): Promise<Outcome<any[]>> {
        const cacheKey = `mb:search:artist:${query}:${limit}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(
                    "/artist",
                    { params: { query, limit, fmt: "json" } },
                    opts.interactive ? INTERACTIVE_PRIORITY : 0
                );
                const artists: any[] = response.data.artists || [];
                if (artists.length === 0) {
                    return absent({ query, limit, hits: 0 });
                }
                return answered(artists, { query, limit, hits: artists.length });
            } catch (err: any) {
                return this.classifyError(err, false);
            }
        });
    }

    async getArtist(
        mbid: string,
        includes: string[] = ["url-rels", "tags"],
        opts: { interactive?: boolean } = {}
    ): Promise<Outcome<any>> {
        const cacheKey = `mb:artist:${mbid}:${includes.join(",")}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(
                    `/artist/${mbid}`,
                    { params: { inc: includes.join("+"), fmt: "json" } },
                    opts.interactive ? INTERACTIVE_PRIORITY : 0
                );
                return answered(response.data, {
                    mbid,
                    includes,
                    source: "musicbrainz",
                });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    async getReleaseGroups(
        artistMbid: string,
        types: string[] = ["album", "ep"],
        limit = 100,
        opts: { interactive?: boolean } = {}
    ): Promise<Outcome<any[]>> {
        const cacheKey = `mb:rg:${artistMbid}:${types.join(",")}:${limit}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(
                    "/release-group",
                    {
                        params: {
                            artist: artistMbid,
                            type: types.join("|"),
                            limit,
                            fmt: "json",
                        },
                    },
                    opts.interactive ? INTERACTIVE_PRIORITY : 0
                );
                const groups: any[] = response.data["release-groups"] || [];
                if (groups.length === 0) {
                    return absent({ artistMbid, types, limit, hits: 0 });
                }
                return answered(groups, {
                    artistMbid,
                    types,
                    limit,
                    hits: groups.length,
                });
            } catch (err: any) {
                return this.classifyError(err, false);
            }
        });
    }

    /** Every release group of these types an artist has: MusicBrainz browses 100 at a time, so this pages to the end. */
    async getAllReleaseGroups(
        artistMbid: string,
        types: string[],
        opts: { interactive?: boolean } = {}
    ): Promise<Outcome<any[]>> {
        const cacheKey = `mb:rg:all:${artistMbid}:${types.join(",")}`;
        return this.cachedOutcome(cacheKey, async () => {
            const groups: any[] = [];
            try {
                for (let offset = 0; ; offset += 100) {
                    const response = await this.rateLimitedGet(
                        "/release-group",
                        { params: { artist: artistMbid, type: types.join("|"), limit: 100, offset, fmt: "json" } },
                        opts.interactive ? INTERACTIVE_PRIORITY : 0
                    );
                    const page: any[] = response.data["release-groups"] || [];
                    groups.push(...page);
                    const total = Number(response.data["release-group-count"] ?? 0);
                    if (page.length === 0 || groups.length >= total) break;
                }
            } catch (err: any) {
                return this.classifyError(err, false);
            }
            if (groups.length === 0) return absent({ artistMbid, types, hits: 0 });
            return answered(groups, { artistMbid, types, hits: groups.length });
        });
    }

    async getReleaseGroup(rgMbid: string): Promise<Outcome<any>> {
        const cacheKey = `mb:rg:${rgMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(
                    `/release-group/${rgMbid}`,
                    { params: { inc: "artist-credits+releases", fmt: "json" } }
                );
                return answered(response.data, { rgMbid, source: "musicbrainz" });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    async getAlbumDetails(rgMbid: string): Promise<Outcome<{
        id: string;
        title: string;
        artistName: string;
        releaseDate?: string;
        trackCount?: number;
        primaryType?: string;
        secondaryTypes?: string[];
    }>> {
        const cacheKey = `mb:album:details:${rgMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const rgResponse = await this.rateLimitedGet(
                    `/release-group/${rgMbid}`,
                    { params: { inc: "releases", fmt: "json" } }
                );
                const rg = rgResponse.data;

                let trackCount = 0;
                if (rg.releases && rg.releases.length > 0) {
                    const releaseId = rg.releases[0].id;
                    const releaseResponse = await this.rateLimitedGet(
                        `/release/${releaseId}`,
                        { params: { inc: "recordings", fmt: "json" } }
                    );
                    trackCount = releaseResponse.data.media?.[0]?.["track-count"] || 0;
                }

                return answered(
                    {
                        id: rg.id,
                        title: rg.title,
                        artistName: rg["artist-credit"]?.[0]?.name || "",
                        releaseDate: rg["first-release-date"],
                        trackCount,
                        primaryType: rg["primary-type"],
                        secondaryTypes: rg["secondary-types"] || [],
                    },
                    { rgMbid, source: "musicbrainz" }
                );
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    async getRelease(releaseMbid: string): Promise<Outcome<any>> {
        const cacheKey = `mb:release:${releaseMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const response = await this.rateLimitedGet(`/release/${releaseMbid}`, {
                    params: {
                        inc: "recordings+artist-credits+labels",
                        fmt: "json",
                    },
                });
                return answered(response.data, {
                    releaseMbid,
                    source: "musicbrainz",
                });
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    /**
     * One album's whole catalogue in two requests: the release group with its releases and genres, then its
     * chosen release's tracklist (each track's credit, ISRCs and genres) and label. Cached 30 days.
     * Matching files to `recordings` is the caller's job.
     */
    async getAlbumCatalogue(rgMbid: string): Promise<Outcome<AlbumCatalogue>> {
        // Every caller asks at background priority, so waiting on a fetch already under way
        // is never slower than asking again.
        const running = this.tracklistsInFlight.get(rgMbid);
        if (running) return running;
        const pending = this.fetchAlbumCatalogue(rgMbid);
        this.tracklistsInFlight.set(rgMbid, pending);
        try {
            return await pending;
        } finally {
            this.tracklistsInFlight.delete(rgMbid);
        }
    }

    private async fetchAlbumCatalogue(rgMbid: string): Promise<Outcome<AlbumCatalogue>> {
        const cacheKey = `mb:album:tracklist:${rgMbid}`;
        return this.cachedOutcome(cacheKey, async () => {
            try {
                const rgResponse = await this.rateLimitedGet(
                    `/release-group/${rgMbid}`,
                    { params: { inc: "releases+genres", fmt: "json" } }
                );
                const rg = rgResponse.data;
                const releases: any[] = rg.releases || [];
                if (releases.length === 0) {
                    return absent({
                        rgMbid,
                        reason: "release group has no releases",
                    });
                }

                const chosen = chooseRelease(releases);
                const releaseResponse = await this.rateLimitedGet(
                    `/release/${chosen.id}`,
                    {
                        params: {
                            inc: "recordings+isrcs+labels+genres+artist-credits",
                            fmt: "json",
                        },
                    }
                );
                const release = releaseResponse.data;

                const recordings = (release.media || [])
                    .flatMap((medium: any) => medium.tracks || [])
                    .filter((t: any) => t.recording)
                    .map((t: any) => ({
                        recordingId: t.recording.id as string,
                        title: (t.title || t.recording.title) as string,
                        position: typeof t.position === "number" ? t.position : null,
                        durationMs:
                            typeof t.recording.length === "number"
                                ? t.recording.length
                                : null,
                        isrcs: (t.recording.isrcs || []) as string[],
                        genres: voteCounts(t.recording.genres),
                        artists: creditNames(t["artist-credit"] || t.recording["artist-credit"]),
                    }));
                if (recordings.length === 0) {
                    return absent({
                        rgMbid,
                        releaseMbid: chosen.id,
                        reason: "release has no tracklist",
                    });
                }

                const year = Number.parseInt(
                    rg["first-release-date"] || chosen.date || "",
                    10
                );

                return answered(
                    {
                        releaseMbid: chosen.id,
                        originalYear: Number.isFinite(year) ? year : null,
                        label:
                            release["label-info"]?.[0]?.label?.name ?? null,
                        genres: voteCounts(rg.genres),
                        recordings,
                    },
                    { rgMbid, releaseMbid: chosen.id, source: "musicbrainz" }
                );
            } catch (err: any) {
                return this.classifyError(err, true);
            }
        });
    }

    /** The exact then fuzzy name queries for a recording; none when the title is all brackets. */
    private recordingQueries(expected: ExpectedRecording): string[] {
        const title = this.escapeLucene(this.normalizeForSearch(expected.title));
        const name = this.escapeLucene(this.normalizeForSearch(expected.artists[0] ?? ""));
        if (!title.trim()) return [];
        return [`recording:"${title}" AND artist:"${name}"`, `${title} AND artist:${name}`];
    }

    /** MusicBrainz's Lucene syntax needs these escaped: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ / */
    private escapeLucene(str: string): string {
        return str.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
    }

    /**
     * The title without edition markers, for matching against release-group
     * titles only; stored titles keep their markers.
     */
    normalizeForSearch(str: string): string {
        return (
            str
                .replace(/\s*\([^)]*\)\s*/g, " ")
                .replace(/\s*\[[^\]]*\]\s*/g, " ")
                .replace(
                    /\s*-\s*(\d{4}\s+)?(deluxe|remastered|remaster|edition|version|expanded|bonus|explicit|clean|single|radio edit|remix|acoustic|live|mono|stereo)(\s+\d{4})?\s*(edition|version|mix)?\s*/gi,
                    " "
                )
                .replace(/\s*-\s*\d{4}\s*$/gi, " ")
                .replace(/\s+/g, " ")
                .trim()
        );
    }

    /**
     * Runs the queries in turn, handing each reply's recordings to `pick` until it answers. A query MusicBrainz refuses
     * (400) is no answer about the track, so the next is asked; a rate limit stops at once; any other failure is the
     * answer when no query found one. Null when every query was asked and none picked.
     */
    private async firstRecordingAnswer<T>(
        queries: string[],
        inc: string | undefined,
        notFoundMeansAbsent: boolean,
        pick: (recordings: any[], query: string) => Outcome<T> | null,
    ): Promise<Outcome<T> | null> {
        let failure: Outcome<never> | undefined;
        for (const query of queries) {
            try {
                const response = await this.rateLimitedGet("/recording", {
                    params: inc ? { query, limit: 50, fmt: "json", inc } : { query, limit: 50, fmt: "json" },
                });
                const answer = pick(response.data.recordings || [], query);
                if (answer) return answer;
            } catch (err: any) {
                if (err?.response?.status === 400) continue;
                const classified = await this.classifyError(err, notFoundMeansAbsent);
                if (classified.kind === "rateLimited") return classified;
                failure ??= classified;
            }
        }
        return failure ?? null;
    }

    /**
     * The album a track appears on, by name search: only a recording that is the track (`recordingAgrees`:
     * title, version, artist, and length when known) counts, and among those a studio album before a single
     * or EP. Recordings MusicBrainz marks live, demo, acoustic, remix or dated are passed over.
     */
    async searchRecording(expected: ExpectedRecording): Promise<
        Outcome<{
            albumName: string;
            albumMbid: string;
            artistMbid: string;
            trackMbid: string;
        }>
    > {
        const artist = expected.artists[0] ?? "";
        const cacheKey = `mb:search:recording:${artist}:${expected.title}:${expected.durationSec ?? ""}`;
        return this.cachedOutcome(cacheKey, async () => {
            const queries = this.recordingQueries(expected);
            if (queries.length === 0) return absent({ title: expected.title, artist, reason: "nothing to search by" });
            const found = await this.firstRecordingAnswer(queries, "releases+release-groups+artists", false, (hits, query) => {
                const recordings = hits.filter(
                    (rec: any) => recordingAgrees(toCandidate(rec), expected) && !isOtherVersion(rec.disambiguation),
                );
                for (const allowSingles of [false, true]) {
                    for (const rec of recordings) {
                        const album = this.extractAlbumFromRecording(rec, allowSingles);
                        if (album) return answered(album, { query, allowSingles });
                    }
                }
                return null;
            });
            return found ?? absent({ title: expected.title, artist, reason: "no recording that is this track is on an album" });
        });
    }

    /**
     * Pick the release group to trust for a recording: score every release
     * (studio albums high; compilations, live, bootlegs, soundtracks
     * penalised) and take the first above the threshold. `allowSingles`
     * lowers the threshold to accept Singles/EPs as a last resort.
     */
    private extractAlbumFromRecording(
        recording: any,
        allowSingles: boolean = false
    ): {
        albumName: string;
        albumMbid: string;
        artistMbid: string;
        trackMbid: string;
    } | null {
        const artistMbid = recording["artist-credit"]?.[0]?.artist?.id || "";
        const trackMbid = recording.id || "";
        const releases = recording.releases || [];
        if (releases.length === 0) return null;

        const scoredReleases = releases.map((release: any) => {
            const rg = release["release-group"];
            if (!rg?.id) return { release, score: -1000 };

            let score = 0;
            const primaryType = rg["primary-type"] || "";
            const secondaryTypes: string[] = rg["secondary-types"] || [];
            const title = (rg.title || "").toLowerCase();

            if (primaryType === "Album") score += 100;
            else if (primaryType === "EP") score += 50;
            else if (primaryType === "Single") score += 25;
            else score -= 50;

            if (secondaryTypes.includes("Compilation")) score -= 200;
            if (secondaryTypes.includes("Live")) score -= 150;
            if (secondaryTypes.includes("Remix")) score -= 100;
            if (secondaryTypes.includes("DJ-mix")) score -= 200;
            if (secondaryTypes.includes("Mixtape/Street")) score -= 100;
            if (secondaryTypes.includes("Soundtrack")) score -= 150;

            if (title.match(/\d{4}[-‐]\d{2}[-‐]\d{2}/)) score -= 300;
            if (title.includes("live at") || title.includes("live from"))
                score -= 150;
            if (title.includes("best of") || title.includes("greatest hits"))
                score -= 200;
            if (title.includes("compilation") || title.includes("collection"))
                score -= 200;
            if (title.includes("soundtrack")) score -= 100;
            if (title.includes("various artists")) score -= 300;
            if (title.includes("sounds of the")) score -= 200;
            if (title.includes("deep sounds")) score -= 200;

            if (release.status === "Official") score += 20;

            return { release, score };
        });

        scoredReleases.sort((a: any, b: any) => b.score - a.score);

        // Normal mode requires > 50 (a studio album); singles mode accepts
        // anything above 0 (a Single), still rejecting penalised junk.
        const threshold = allowSingles ? 0 : 50;
        const bestResult = scoredReleases.find((r: any) => r.score > threshold);

        if (!bestResult) {
            logger.debug(
                `[MusicBrainz] Skipping recording - no ${
                    allowSingles ? "singles" : "albums"
                } found in ${releases.length} releases (threshold: ${threshold})`
            );
            return null;
        }

        const bestRelease = bestResult.release;
        const releaseGroup = bestRelease["release-group"];
        if (!releaseGroup?.id) return null;

        logger.debug(
            `[MusicBrainz] Selected "${releaseGroup.title}" (score: ${bestResult.score}) from ${releases.length} releases`
        );

        return {
            albumName:
                releaseGroup.title || bestRelease.title || "Unknown Album",
            albumMbid: releaseGroup.id,
            artistMbid,
            trackMbid,
        };
    }

    /** Every recording MusicBrainz files under an ISRC, as candidates for `pickRecording`. A code that is not an
     * ISRC is never sent; one MusicBrainz refuses (400) or does not know (404) is `absent`, not a failure. */
    async lookupRecordingsByIsrc(isrc: string): Promise<Outcome<CandidateRecording[]>> {
        const code = normalizeIsrc(isrc);
        if (!code) return absent({ isrc, reason: "not an ISRC" });
        return this.cachedOutcome(`mb:isrc:recordings:${code}`, async () => {
            try {
                const response = await this.rateLimitedGet(`/isrc/${code}`, {
                    params: { fmt: "json", inc: "artist-credits" },
                });
                const recordings: any[] = response.data.recordings || [];
                if (recordings.length === 0) return absent({ isrc: code, hits: 0 });
                return answered(recordings.map(toCandidate), { isrc: code, hits: recordings.length });
            } catch (err: any) {
                if (err?.response?.status === 400) {
                    return absent({ isrc: code, reason: "MusicBrainz refused the code" });
                }
                return this.classifyError(err, true);
            }
        });
    }

    /**
     * The recording a track is, by name: MusicBrainz's search candidates for its
     * title and artist, kept only when `recordingAgrees` (title, version, artist,
     * length). Exact search first, then fuzzy; errors are never folded into
     * "no match".
     */
    async identifyRecording(expected: ExpectedRecording): Promise<Outcome<CandidateRecording>> {
        const artist = expected.artists[0] ?? "";
        const cacheKey = `mb:identify:recording:${artist}:${expected.title}:${expected.durationSec ?? ""}`;
        return this.cachedOutcome(cacheKey, async () => {
            const queries = this.recordingQueries(expected);
            if (queries.length === 0) return absent({ title: expected.title, artist, reason: "nothing to search by" });
            let offered = 0;
            const found = await this.firstRecordingAnswer(queries, undefined, true, (hits, query) => {
                const candidates = hits.map(toCandidate);
                offered += candidates.length;
                const pick = pickRecording(candidates, expected);
                return pick ? answered(pick, { query, offered: candidates.length }) : null;
            });
            return found ?? absent({ title: expected.title, artist, offered, reason: "no candidate is this track" });
        });
    }

    /**
     * A recording's first ISRC and its genres from one request: asked separately they are two
     * requests to the same page, at MusicBrainz's one a second. Each answer is cached under the
     * key its single lookup uses, so either finds it.
     */
    async getRecordingIsrcAndGenres(recordingId: string): Promise<{
        isrc: Outcome<string>;
        genres: Outcome<RecordingGenres>;
    }> {
        const isrcKey = `mb:recording:isrc:${recordingId}`;
        const genresKey = `mb:recording:genres:${recordingId}`;
        const [cachedIsrc, cachedGenres] = await Promise.all([
            this.readCached<string>(isrcKey),
            this.readCached<RecordingGenres>(genresKey),
        ]);
        if (cachedIsrc && cachedGenres) return { isrc: cachedIsrc, genres: cachedGenres };
        try {
            const response = await this.rateLimitedGet(`/recording/${recordingId}`, {
                params: { fmt: "json", inc: "isrcs+genres+tags" },
            });
            const data = response.data;
            const first = (data.isrcs || [])[0];
            const isrc: Outcome<string> = first
                ? answered(first, { recordingId })
                : absent({ recordingId, reason: "no ISRC" });
            const genreList = voteCounts(data.genres);
            const tagList = voteCounts(data.tags);
            const genres =
                genreList.length === 0 && tagList.length === 0
                    ? absent({ recordingId, reason: "no genres or tags" })
                    : answered({ genres: genreList, tags: tagList }, { recordingId, genres: genreList.length, tags: tagList.length });
            await Promise.all([this.writeCached(isrcKey, isrc), this.writeCached(genresKey, genres)]);
            return { isrc, genres };
        } catch (err: any) {
            const failed = await this.classifyError(err, true);
            return { isrc: failed, genres: failed };
        }
    }

    /** A recording's genres (curated) and tags (crowd-sourced); `absent` when it has neither. */
    async getRecordingGenres(recordingId: string): Promise<Outcome<RecordingGenres>> {
        const cached = await this.readCached<RecordingGenres>(`mb:recording:genres:${recordingId}`);
        return cached ?? (await this.getRecordingIsrcAndGenres(recordingId)).genres;
    }

}

export const musicBrainzService = new MusicBrainzService();