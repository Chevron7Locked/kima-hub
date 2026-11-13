import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { onSystemSettingsChange } from "../utils/systemSettingsSubscribers";
import { UserFacingError } from "../utils/errors";

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
     * Stream an audiobook with authentication, as a readable stream to pipe to the
     * response. Tracks come from a 5-minute in-process cache, so a seek does not pay
     * an ABS round-trip.
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
}

export const audiobookshelfService = new AudiobookshelfService();

onSystemSettingsChange(["audiobookshelfEnabled", "audiobookshelfUrl", "audiobookshelfApiKey"], () =>
    audiobookshelfService.reinitialize(),
);
