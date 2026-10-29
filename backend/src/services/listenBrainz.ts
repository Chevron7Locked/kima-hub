/**
 * ListenBrainz: similar artists (its artist-similarity model, read from the Labs
 * API with the algorithm its own artist pages use), sitewide top artists, and
 * listen submission with the user's token. LB asks for at most 1 request/s; the
 * 'listenbrainz' rate limiter allows one per 1.1 s for both hosts.
 */

import axios from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { INTERACTIVE_PRIORITY, rateLimiter } from "./rateLimiter";
import { USER_AGENT } from "../config";
import { prisma } from "../utils/db";
import { decrypt, isEncryptedFormat } from "../utils/encryption";

export interface SimilarArtist {
    name: string;
    mbid?: string;
    match: number; // 0-1 similarity score
    url: string;
}

interface ChartArtist {
    type: "music";
    id: string;
    name: string;
    listeners: number;
    playCount: number;
    url: string;
    mbid: string;
}

/** One of an artist's most-listened recordings, sitewide (popularity API). */
interface LbTopRecording {
    recordingMbid: string;
    title: string;
    releaseMbid: string | null;
    releaseName: string | null;
    lengthMs: number;
    listeners: number;
    playCount: number;
}

const LB_BASE = process.env.LISTENBRAINZ_API_URL || "https://api.listenbrainz.org";
const LB_LABS_BASE = process.env.LISTENBRAINZ_LABS_URL || "https://labs.api.listenbrainz.org";
/** The model ListenBrainz's artist pages show similar artists from
 * (listenbrainz-server, webserver/views/entity_pages.py). */
const SIMILAR_ARTISTS_ALGORITHM =
    "session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30";
/** 7 days: similarity data changes slowly. */
const SIMILAR_TTL = 604800;
/** 1 day for an artist ListenBrainz has no similarity data for yet. */
const SIMILAR_EMPTY_TTL = 86400;

class ListenBrainzService {
    private client = axios.create({
        baseURL: LB_BASE,
        timeout: 10000,
        headers: { "User-Agent": USER_AGENT },
    });

    private labs = axios.create({
        baseURL: LB_LABS_BASE,
        timeout: 10000,
        headers: { "User-Agent": USER_AGENT },
    });

    /**
     * The playing user's own LB token, or null when they have not saved
     * one. Scrobbling is per-user — there is no server-wide token; rows
     * that are not valid ciphertext (bad key, hand-edited value) fail
     * closed to null, same policy as `utils/encryption`.
     */
    async getUserToken(userId: string): Promise<string | null> {
        const row = await prisma.userSettings.findUnique({
            where: { userId },
            select: { listenbrainzToken: true },
        });
        const stored = row?.listenbrainzToken;
        if (!stored) return null;
        if (!isEncryptedFormat(stored)) {
            logger.warn(
                `[ListenBrainz] Unencrypted token stored for ${userId} — treating as not configured`
            );
            return null;
        }
        try {
            const token = decrypt(stored);
            return token.length > 0 ? token : null;
        } catch (err) {
            logger.warn(
                `[ListenBrainz] Token for ${userId} cannot be decrypted — scrobbles skip`
            );
            return null;
        }
    }

    private async rateLimitedGet<T = any>(
        path: string,
        params: Record<string, unknown>,
        token?: string | null,
        priority = 0
    ): Promise<T> {
        return rateLimiter.execute(
            "listenbrainz",
            async () => {
                const res = await this.client.get<T>(path, {
                    params,
                    ...(token ? { headers: { Authorization: `Token ${token}` } } : {}),
                });
                return res.data;
            },
            { priority }
        );
    }

    /**
     * Similar artists from ListenBrainz's similarity model, strongest first. The
     * model's score is spread over 0.5–0.95 against the batch's strongest, the
     * range the discover-weekly tiers and the library re-rank read. An artist LB
     * has no data for is remembered for a day; an error is never remembered.
     */
    async getSimilarArtists(
        artistMbid: string,
        artistName: string,
        limit = 30,
        opts: { interactive?: boolean } = {}
    ): Promise<SimilarArtist[]> {
        const cacheKey = `lb:similar:v2:${artistMbid || artistName}:${limit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) return JSON.parse(cached) as SimilarArtist[];
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const rows = await rateLimiter.execute(
                "listenbrainz",
                async () =>
                    (
                        await this.labs.get<unknown>("/similar-artists/json", {
                            params: { artist_mbids: artistMbid, algorithm: SIMILAR_ARTISTS_ALGORITHM },
                        })
                    ).data,
                { priority: opts.interactive ? INTERACTIVE_PRIORITY : 0 }
            );
            const similar = (Array.isArray(rows) ? rows : [])
                .filter((r: any) => r?.artist_mbid && r?.name && r.artist_mbid !== artistMbid && Number(r.score) > 0)
                .sort((a: any, b: any) => Number(b.score) - Number(a.score))
                .slice(0, limit);
            const strongest = similar.length > 0 ? Number(similar[0].score) : 1;
            const results: SimilarArtist[] = similar.map((r: any) => ({
                name: r.name,
                mbid: r.artist_mbid,
                match: 0.5 + (0.45 * Number(r.score)) / strongest,
                url: `https://listenbrainz.org/artist/${r.artist_mbid}`,
            }));
            try {
                await redisClient.setex(
                    cacheKey,
                    results.length > 0 ? SIMILAR_TTL : SIMILAR_EMPTY_TTL,
                    JSON.stringify(results)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }
            return results;
        } catch (error) {
            // An error is not "no similar artists": the caller decides what a failed source means.
            logger.warn(`ListenBrainz similar-artists error for ${artistName} (${artistMbid}):`, error);
            throw error;
        }
    }

    /**
     * Sitewide top artists, cached 6 hours. Images are resolved by callers
     * via the existing artwork cascade — LB chart entries carry no images.
     */
    async getTopChartArtists(limit = 20): Promise<ChartArtist[]> {
        const cacheKey = `lb:chart:artists:${limit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) return JSON.parse(cached) as ChartArtist[];
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.rateLimitedGet<any>(
                "/1/stats/sitewide/artists",
                { stat_type: "top_artists", count: limit }
            );
            const artists: any[] = data?.payload?.artists || [];
            const results: ChartArtist[] = artists
                .filter((a) => a?.artist_mbid && a?.artist_name)
                .slice(0, limit)
                .map((a) => ({
                    type: "music" as const,
                    id: a.artist_mbid,
                    name: a.artist_name,
                    listeners: Number(a.listen_count) || 0,
                    playCount: Number(a.listen_count) || 0,
                    url: `https://listenbrainz.org/artist/${a.artist_mbid}`,
                    mbid: a.artist_mbid,
                }));
            if (results.length > 0) {
                // Charts move slowly; cache 6h.
                await redisClient.setex(cacheKey, 21600, JSON.stringify(results));
            }
            return results;
        } catch (error) {
            logger.warn("ListenBrainz sitewide chart error:", error);
            return [];
        }
    }

    /**
     * An artist's most-listened recordings across all of ListenBrainz,
     * strongest first. The popularity endpoint needs a token (any user's;
     * it is gated against scrapers, not use), so the playing user's own
     * scrobble token unlocks it. The artist page's "Popular" section reads
     * this; with no token or no data the caller falls to Deezer and the
     * local floor. Ranked data moves slowly; cached 6h.
     */
    async getTopRecordingsForArtist(
        artistMbid: string,
        userId: string,
        limit = 10
    ): Promise<LbTopRecording[]> {
        // ListenBrainz requires an auth token on popularity endpoints
        // (anonymous calls now get 401 at their gateway). That is an
        // opt-in bonus for users who connected ListenBrainz for scrobbling:
        // anyone without a token skips straight to the Deezer tier, so
        // nothing in Kima asks a user to sign up anywhere.
        const token = await this.getUserToken(userId);
        if (!token) return [];

        const cacheKey = `lb:top-rec:${artistMbid}:${limit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) return JSON.parse(cached) as LbTopRecording[];
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const rows = await this.rateLimitedGet<any>(
                `/1/popularity/top-recordings-for-artist/${artistMbid}`,
                { count: limit },
                token,
                INTERACTIVE_PRIORITY
            );
            const results: LbTopRecording[] = (Array.isArray(rows) ? rows : [])
                .filter((r: any) => r?.recording_mbid && r?.recording_name)
                .slice(0, limit)
                .map((r: any) => ({
                    recordingMbid: r.recording_mbid,
                    title: r.recording_name,
                    releaseMbid: r.release_mbid || null,
                    releaseName: r.release_name || null,
                    lengthMs: Number(r.length) || 0,
                    listeners: Number(r.total_user_count) || 0,
                    playCount: Number(r.total_listen_count) || 0,
                }));
            if (results.length > 0) {
                await redisClient.setex(cacheKey, 21600, JSON.stringify(results));
            }
            return results;
        } catch (error) {
            // An error is not "no data": the caller decides what a failed
            // source means.
            logger.warn(`ListenBrainz top recordings error for ${artistMbid}:`, error);
            throw error;
        }
    }

    /**
     * Submit listens (scrobbling) with the playing user's own token. With
     * no token configured this is a silent no-op (returns false) — Kima's
     * play log is local and stays the source of truth; LB is a mirror,
     * never the record.
     */
    async submitListens(
        userId: string,
        listens: Array<{
            artist: string;
            track: string;
            /** The album title. */
            release?: string;
            listenedAt: number; // unix seconds
        }>
    ): Promise<boolean> {
        const token = await this.getUserToken(userId);
        if (!token) {
            logger.debug("[ListenBrainz] No user token configured — skipping submit");
            return false;
        }

        try {
            // https://listenbrainz.readthedocs.io/en/latest/users/json.html
            const payload = {
                listen_type: listens.length === 1 ? "single" : "import",
                payload: listens.map((l) => ({
                    listened_at: l.listenedAt,
                    track_metadata: {
                        artist_name: l.artist,
                        track_name: l.track,
                        ...(l.release ? { release_name: l.release } : {}),
                        additional_info: { media_player: "kima", submission_client: "kima" },
                    },
                })),
            };
            const res = await rateLimiter.execute("listenbrainz", async () => {
                const r = await this.client.post("/1/submit-listens", payload, {
                    headers: {
                        Authorization: `Token ${token}`,
                        "Content-Type": "application/json",
                    },
                });
                return r;
            });
            if (res.status === 200) {
                logger.debug(`[ListenBrainz] Submitted ${listens.length} listen(s)`);
                return true;
            }
            logger.warn(`[ListenBrainz] submit-listens returned ${res.status}`);
            return false;
        } catch (error: any) {
            logger.warn(
                `[ListenBrainz] submit-listens failed: ${error?.message || error}`
            );
            return false;
        }
    }

}

export const listenBrainzService = new ListenBrainzService();
