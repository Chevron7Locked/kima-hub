import axios, { AxiosInstance } from "axios";
import pLimit from "p-limit";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { buildSections, resolveMetaTags } from "./audiobookSections";
import { UserFacingError } from "../utils/errors";
import { artistSortName } from "./artistIdentity";

const TRACK_CACHE_TTL_MS = 5 * 60 * 1000;

interface TrackEntry {
    index: number;
    startOffset: number;
    duration: number;
    contentUrl: string;
}

interface TrackCacheEntry {
    tracks: TrackEntry[];
    fetchedAt: number;
}

/**
 * Audiobookshelf API Service
 * Handles all interactions with the Audiobookshelf server
 */
class AudiobookshelfService {
    private client: AxiosInstance | null = null;
    private baseUrl: string | null = null;
    private apiKey: string | null = null;
    private initialized = false;
    private podcastCache: { items: any[]; expiresAt: number } | null = null;
    private readonly PODCAST_CACHE_TTL_MS = 5 * 60 * 1000;
    private trackCache = new Map<string, TrackCacheEntry>();

    private async ensureInitialized() {
        if (this.initialized && this.client) return;

        try {
            // Try to get from database first
            const settings = await getSystemSettings();

            // Check if Audiobookshelf is explicitly disabled
            if (settings && settings.audiobookshelfEnabled === false) {
                throw new UserFacingError("Audiobookshelf is disabled in settings");
            }

            if (
                settings?.audiobookshelfEnabled &&
                settings?.audiobookshelfUrl &&
                settings?.audiobookshelfApiKey
            ) {
                this.baseUrl = settings.audiobookshelfUrl.replace(/\/$/, ""); // Remove trailing slash
                this.apiKey = settings.audiobookshelfApiKey;
                this.client = axios.create({
                    baseURL: this.baseUrl as string,
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    timeout: 30000, // 30 seconds for remote server
                });
                logger.debug("Audiobookshelf configured from database");
                this.initialized = true;
                return;
            }
        } catch (error: any) {
            if (error.message === "Audiobookshelf is disabled in settings") {
                throw error;
            }
            logger.debug(
                "  Could not load Audiobookshelf from database, checking .env"
            );
        }

        // Fallback to .env
        if (
            process.env.AUDIOBOOKSHELF_URL &&
            process.env.AUDIOBOOKSHELF_API_KEY
        ) {
            this.baseUrl = process.env.AUDIOBOOKSHELF_URL.replace(/\/$/, "");
            this.apiKey = process.env.AUDIOBOOKSHELF_API_KEY;
            this.client = axios.create({
                baseURL: this.baseUrl,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                },
                timeout: 30000, // 30 seconds for remote server
            });
            logger.debug("Audiobookshelf configured from .env");
            this.initialized = true;
        } else {
            throw new UserFacingError("Audiobookshelf is not configured — add the server URL and API key in Settings");
        }
    }

    reinitialize(): void {
        this.initialized = false;
        this.client = null;
        this.baseUrl = null;
        this.apiKey = null;
        this.trackCache.clear();
    }

    /**
     * Test connection to Audiobookshelf
     */
    async ping(): Promise<boolean> {
        try {
            await this.ensureInitialized();
            const response = await this.client!.get("/api/libraries");
            return response.status === 200;
        } catch (error) {
            logger.error("Audiobookshelf connection failed:", error);
            return false;
        }
    }

    /**
     * Get all libraries from Audiobookshelf
     */
    async getLibraries() {
        await this.ensureInitialized();
        const response = await this.client!.get("/api/libraries");
        return response.data.libraries || [];
    }

    /**
     * Get all audiobooks from a specific library
     */
    async getLibraryItems(libraryId: string) {
        await this.ensureInitialized();
        const response = await this.client!.get(
            `/api/libraries/${libraryId}/items`
        );
        return response.data.results || [];
    }

    /**
     * Get all audiobooks from all libraries
     */
    async getAllAudiobooks() {
        await this.ensureInitialized();
        const libraries = await this.getLibraries();

        const allBooks: any[] = [];
        for (const library of libraries) {
            if (library.mediaType === "book") {
                // Only get audiobook libraries
                const items = await this.getLibraryItems(library.id);
                allBooks.push(...items);
            }
        }

        return allBooks;
    }

    /**
     * Get all podcasts from all libraries
     */
    async getAllPodcasts(forceRefresh = false) {
        await this.ensureInitialized();

        if (
            !forceRefresh &&
            this.podcastCache &&
            this.podcastCache.expiresAt > Date.now()
        ) {
            return this.podcastCache.items;
        }

        const libraries = await this.getLibraries();
        const podcastLibraries = libraries.filter(
            (library: any) => library.mediaType === "podcast"
        );

        const libraryResults = await Promise.all(
            podcastLibraries.map(async (library: any) => {
                try {
                    return await this.getLibraryItems(library.id);
                } catch (error) {
                    logger.error(
                        `Audiobookshelf: failed to load podcast library ${library.id}`,
                        error
                    );
                    return [];
                }
            })
        );

        const allPodcasts = libraryResults.flat();

        this.podcastCache = {
            items: allPodcasts,
            expiresAt: Date.now() + this.PODCAST_CACHE_TTL_MS,
        };

        return allPodcasts;
    }

    /**
     * Get a specific audiobook by ID
     */
    async getAudiobook(audiobookId: string) {
        await this.ensureInitialized();
        const response = await this.client!.get(
            `/api/items/${audiobookId}?expanded=1`
        );
        return response.data;
    }

    /**
     * Get a specific podcast by ID (alias for getAudiobook since API is the same)
     */
    async getPodcast(podcastId: string) {
        return this.getAudiobook(podcastId);
    }

    /**
     * Get user's progress for an audiobook
     */
    async getProgress(audiobookId: string) {
        await this.ensureInitialized();
        const response = await this.client!.get(
            `/api/me/progress/${audiobookId}`
        );
        return response.data;
    }

    /**
     * Update user's progress for an audiobook
     */
    async updateProgress(
        audiobookId: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        await this.ensureInitialized();
        const response = await this.client!.patch(
            `/api/me/progress/${audiobookId}`,
            {
                currentTime,
                duration,
                isFinished,
            }
        );
        return response.data;
    }

    /**
     * Get stream URL for an audiobook
     */
    async getStreamUrl(audiobookId: string): Promise<string> {
        await this.ensureInitialized();
        return `${this.baseUrl}/api/items/${audiobookId}/play`;
    }

    /**
     * Stream an audiobook with authentication.
     * Returns a readable stream that can be piped to the response.
     *
     * Tracks are resolved from a 5-minute in-process cache to avoid paying an
     * ABS round-trip on every seek/range request.
     */
    async streamAudiobook(
        audiobookId: string,
        rangeHeader?: string,
        trackIndex?: number,
    ) {
        await this.ensureInitialized();

        const cached = this.trackCache.get(audiobookId);
        let tracks: TrackEntry[];
        if (cached && Date.now() - cached.fetchedAt < TRACK_CACHE_TTL_MS) {
            tracks = cached.tracks;
        } else {
            const audiobook = await this.getAudiobook(audiobookId);
            tracks = ((audiobook.media?.tracks ?? []) as any[])
                .slice()
                .sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0))
                .map((t) => ({
                    index: t.index as number,
                    startOffset: (t.startOffset ?? 0) as number,
                    duration: (t.duration ?? 0) as number,
                    contentUrl: t.contentUrl as string,
                }));
            this.trackCache.set(audiobookId, { tracks, fetchedAt: Date.now() });
        }

        let track: TrackEntry | undefined;
        if (trackIndex === undefined || trackIndex === null) {
            track = tracks[0];
        } else {
            track = tracks.find((t) => t.index === trackIndex);
            if (!track) {
                logger.warn(
                    `[ABS] streamAudiobook: trackIndex=${trackIndex} not found, falling back to first track`,
                );
                track = tracks[0];
            }
        }

        if (!track?.contentUrl) {
            throw new Error("No audio track found for this audiobook");
        }

        const reqHeaders: Record<string, string> = {};
        if (rangeHeader) {
            reqHeaders["Range"] = rangeHeader;
        }

        const response = await this.client!.get(track.contentUrl, {
            responseType: "stream",
            // Bounds time-to-response-headers; body stalls are handled by the
            // server socket timeout and client recovery.
            timeout: 15_000,
            headers: reqHeaders,
            // Accept 206 Partial Content, and let 416 Range Not Satisfiable pass
            // through as-is instead of throwing (axios would otherwise surface a
            // valid 416 -- e.g. a seek past a file whose metadata size is wrong --
            // as a 500).
            validateStatus: (status) =>
                (status >= 200 && status < 300) || status === 416,
        });

        return {
            stream: response.data,
            headers: response.headers,
            status: response.status,
        };
    }

    /**
     * Search audiobooks
     */
    async searchAudiobooks(query: string) {
        await this.ensureInitialized();
        const response = await this.client!.get(
            `/api/search/books?q=${encodeURIComponent(query)}`
        );
        return response.data.book || [];
    }

    /**
     * Sync audiobooks from Audiobookshelf to local database cache.
     * This populates the Audiobook table for full-text search.
     *
     * For items whose tracksJson is NULL or whose numTracks changed, fetches
     * the expanded item (GET /api/items/:id?expanded=1) with bounded concurrency
     * (limit 4) to persist the track map. Only changed/missing rows pay the
     * extra fetch.
     */
    async syncAudiobooksToCache() {
        await this.ensureInitialized();
        // Invalidate the stream track cache so seeks pick up fresh data.
        this.trackCache.clear();
        logger.debug("[AUDIOBOOKSHELF] Starting audiobook sync to cache...");

        try {
            const audiobooks = await this.getAllAudiobooks();
            logger.debug(
                `[AUDIOBOOKSHELF] Found ${audiobooks.length} audiobooks to sync`
            );

            // Load existing rows so we can decide which need an expanded fetch.
            const existingRows = await prisma.audiobook.findMany({
                select: { id: true, numTracks: true, tracksJson: true, sectionsJson: true },
            });
            const existingMap = new Map(existingRows.map((r) => [r.id, r]));

            // Mis-cataloged-library guard: no real audiobook has 1000+ audio
            // files. These ingest as multi-thousand-hour / tens-of-GB monsters
            // that break seeking and the player. (Duration is NOT a safe
            // signal -- legitimate omnibus editions run 50-65h.)
            const miscatalogedTrackCount = (item: any): number | null => {
                const trackCount = item.media?.tracks?.length ?? item.media?.numTracks ?? 0;
                return trackCount > 1000 ? trackCount : null;
            };

            // Prefetch expanded data (tracks, chapters, audioFiles) with bounded concurrency
            // BEFORE the sequential upsert loop -- awaiting inside the loop would serialize.
            const limit = pLimit(4);
            const expandedData = new Map<
                string,
                {
                    tracks: { index: number; startOffset: number; duration: number }[];
                    sections: { index: number; title: string; start: number }[];
                    firstFileMeta: Record<string, string> | null;
                }
            >();
            const needsExpanded = audiobooks.filter((item) => {
                if (miscatalogedTrackCount(item) !== null) return false;
                const existing = existingMap.get(item.id);
                return (
                    !existing ||
                    existing.tracksJson === null ||
                    existing.sectionsJson === null ||
                    existing.numTracks !== (item.media?.numTracks ?? null)
                );
            });
            await Promise.all(
                needsExpanded.map((item) =>
                    limit(async () => {
                        try {
                            const expanded = await this.getAudiobook(item.id);
                            const rawTracks: any[] = expanded.media?.tracks ?? [];
                            const rawChapters: any[] = expanded.media?.chapters ?? [];
                            const rawAudioFiles: any[] = expanded.media?.audioFiles ?? [];
                            const expandedDuration: number =
                                expanded.media?.duration ?? item.media?.duration ?? 0;

                            const tracks = rawTracks.map((t) => ({
                                index: t.index as number,
                                startOffset: (t.startOffset ?? 0) as number,
                                duration: (t.duration ?? 0) as number,
                            }));
                            const sections = buildSections({
                                duration: expandedDuration,
                                chapters: rawChapters,
                                tracks: rawTracks.map((t: any) => ({
                                    startOffset: (t.startOffset ?? 0) as number,
                                    name: rawAudioFiles.find((af: any) => af.index === t.index)?.metadata?.filename as string | undefined,
                                })),
                            });
                            const firstFileMeta = rawAudioFiles[0]?.metaTags ?? null;

                            expandedData.set(item.id, { tracks, sections, firstFileMeta });
                        } catch (err: any) {
                            logger.warn(
                                `[AUDIOBOOKSHELF] Could not fetch expanded data for ${item.id}: ${err.message}`
                            );
                        }
                    })
                )
            );

            let syncedCount = 0;
            let skippedCount = 0;

            for (const item of audiobooks) {
                try {
                    const skippedTrackCount = miscatalogedTrackCount(item);
                    if (skippedTrackCount !== null) {
                        logger.warn(
                            `[AUDIOBOOKSHELF] Skipping "${item.media?.metadata?.title || item.id}": ${skippedTrackCount} tracks -- looks like a mis-cataloged library, not a single audiobook`
                        );
                        skippedCount++;
                        continue;
                    }

                    const metadata = item.media?.metadata || {};

                    let series: string | null = null;
                    let seriesSequence: string | null = null;

                    if (metadata.series && Array.isArray(metadata.series) && metadata.series.length > 0) {
                        series = metadata.series[0].name || null;
                        seriesSequence = metadata.series[0].sequence || null;
                    } else if (metadata.seriesName) {
                        series = metadata.seriesName;
                        seriesSequence = metadata.seriesSequence || null;
                    }

                    const incomingNumTracks: number | null = item.media?.numTracks ?? null;
                    const expandedEntry = expandedData.get(item.id);
                    const tracksJson = expandedEntry?.tracks;
                    const sectionsJson = expandedEntry?.sections;
                    const firstMeta = expandedEntry?.firstFileMeta ?? null;

                    const {
                        narrator: resolvedNarrator,
                        genres: resolvedGenres,
                        publishedYear: resolvedYear,
                    } = resolveMetaTags(
                        metadata.narratorName || metadata.narrator || null,
                        metadata.genres || [],
                        metadata.publishedYear ? parseInt(metadata.publishedYear, 10) : null,
                        firstMeta,
                    );

                    const title = metadata.title || "Untitled";
                    const sharedData = {
                        title,
                        // One shared object for both the create and update
                        // branches below, so this refreshes on every sync the
                        // same way `title` does -- see audiobookCache.ts's
                        // upsert for the same reasoning spelled out in full.
                        sortName: artistSortName(title),
                        author: metadata.authorName || metadata.author || null,
                        narrator: resolvedNarrator,
                        description: metadata.description || null,
                        publishedYear: resolvedYear,
                        publisher: metadata.publisher || null,
                        series,
                        seriesSequence,
                        duration: item.media?.duration || null,
                        numTracks: incomingNumTracks,
                        size: item.media?.size ? BigInt(item.media.size) : null,
                        isbn: metadata.isbn || null,
                        asin: metadata.asin || null,
                        language: metadata.language || null,
                        genres: resolvedGenres,
                        tags: item.media?.tags || [],
                        coverUrl: metadata.coverPath
                            ? `${this.baseUrl}${metadata.coverPath}`
                            : null,
                        audioUrl: `${this.baseUrl}/api/items/${item.id}/play`,
                        libraryId: item.libraryId || null,
                        lastSyncedAt: new Date(),
                        ...(tracksJson !== undefined && { tracksJson }),
                        ...(sectionsJson !== undefined && { sectionsJson }),
                    };

                    await prisma.audiobook.upsert({
                        where: { id: item.id },
                        update: sharedData,
                        create: { id: item.id, ...sharedData },
                    });
                    syncedCount++;
                } catch (error) {
                    logger.error(
                        `[AUDIOBOOKSHELF] Failed to sync audiobook ${item.id}:`,
                        error
                    );
                }
            }

            logger.debug(
                `[AUDIOBOOKSHELF] Successfully synced ${syncedCount}/${audiobooks.length} audiobooks to cache` +
                (skippedCount > 0 ? ` (${skippedCount} skipped as mis-cataloged)` : "")
            );
            return { synced: syncedCount, total: audiobooks.length, skipped: skippedCount };
        } catch (error) {
            logger.error("[AUDIOBOOKSHELF] Audiobook sync failed:", error);
            throw error;
        }
    }
}

export const audiobookshelfService = new AudiobookshelfService();
