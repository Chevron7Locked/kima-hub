import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";
import { stripAlbumEdition } from "../utils/artistNormalization";
import { lidarrApiCallsTotal, lidarrApiDuration } from "../utils/metrics";
import type {
    LidarrAlbum,
    LidarrArtist,
    LidarrTag,
    LidarrRootFolder,
    LidarrQualityProfile,
    LidarrWebhookPayload,
    LidarrAddAlbumRequest,
    LidarrAddArtistRequest,
    LidarrQueueItem,
    LidarrQueueResponse,
    LidarrHistoryRecord,
    LidarrHistoryResponse,
} from "../types/lidarr";

/**
 * Error types for music acquisition failures
 * Used to determine fallback strategies
 */
export enum AcquisitionErrorType {
    ALBUM_NOT_FOUND = "ALBUM_NOT_FOUND",
    NO_RELEASES_AVAILABLE = "NO_RELEASES_AVAILABLE",
}

/**
 * Structured error class for acquisition failures
 * Includes error type and recoverability flag for fallback logic
 */
export class AcquisitionError extends Error {
    public readonly type: AcquisitionErrorType;
    public readonly isRecoverable: boolean;
    public readonly originalError?: Error;

    constructor(
        message: string,
        type: AcquisitionErrorType,
        isRecoverable: boolean = true,
        originalError?: Error
    ) {
        super(message);
        this.name = "AcquisitionError";
        this.type = type;
        this.isRecoverable = isRecoverable;
        this.originalError = originalError;
        
        // Maintain proper stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AcquisitionError);
        }
    }
}

// Discovery tag label - used to identify discovery artists in Lidarr
const DISCOVERY_TAG_LABEL = "lidify-discovery";

// Simple interface for MusicBrainz artist data (from external service)
interface MusicBrainzArtist {
    id: string;
    name: string;
    type?: string;
}

class LidarrService {
    private client: AxiosInstance | null = null;
    private enabled: boolean;
    private initialized: boolean = false;

    // API timeouts
    private readonly API_TIMEOUT_DEFAULT = 30000;
    private readonly API_TIMEOUT_INDEXER_SEARCH = 60000;

    // Command polling
    private readonly COMMAND_POLL_TIMEOUT_DEFAULT = 30000;
    private readonly COMMAND_POLL_INTERVAL = 2000;

    // Metadata fetching
    private readonly METADATA_FETCH_MAX_ATTEMPTS = 20;
    private readonly METADATA_FETCH_DELAY = 3000;
    private readonly METADATA_FETCH_TOTAL_TIMEOUT = 60000;

    // Root folder management
    private readonly ROOT_FOLDER_CREATE_DELAY = 2000;

    constructor() {
        // Initial check from .env (for backwards compatibility)
        this.enabled = config.lidarr?.enabled || false;

        if (this.enabled && config.lidarr) {
            this.client = axios.create({
                baseURL: config.lidarr.url,
                timeout: this.API_TIMEOUT_DEFAULT,
                headers: {
                    "X-Api-Key": config.lidarr.apiKey,
                },
            });
        }
    }

    private async ensureInitialized() {
        if (this.initialized) return;

        try {
            // Try to load from database
            const settings = await getSystemSettings();

            if (settings && settings.lidarrEnabled) {
                const url = settings.lidarrUrl || config.lidarr?.url;
                const apiKey = settings.lidarrApiKey || config.lidarr?.apiKey;

                if (url && apiKey) {
                    logger.debug("Lidarr configured from database");
                    this.client = axios.create({
                        baseURL: url,
                        timeout: this.API_TIMEOUT_DEFAULT,
                        headers: {
                            "X-Api-Key": apiKey,
                        },
                    });
                    this.enabled = true;
                } else {
                    logger.warn("  Lidarr enabled but missing URL or API key");
                    this.enabled = false;
                }
            } else if (config.lidarr) {
                // Fallback to .env
                logger.debug("Lidarr configured from .env");
                this.enabled = true;
            } else {
                logger.debug("  Lidarr not enabled");
                this.enabled = false;
            }
        } catch (error) {
            logger.error("Failed to load Lidarr settings:", error);
            // Keep .env config if database fails
        }

        this.initialized = true;
    }

    async isEnabled(): Promise<boolean> {
        await this.ensureInitialized();
        return this.enabled;
    }

    reinitialize(): void {
        this.initialized = false;
        this.client = null;
        this.enabled = false;
    }

    /**
     * Wrapper for API calls with metrics tracking
     */
    private async apiCall<T>(
        endpoint: string,
        method: 'get' | 'post' | 'put' | 'delete',
        data?: unknown
    ): Promise<T> {
        const startTime = Date.now();
        let status = 'success';

        try {
            if (!this.client) {
                throw new Error('Lidarr client not initialized');
            }

            let response;
            switch (method) {
                case 'get':
                    response = await this.client.get(endpoint);
                    break;
                case 'post':
                    response = await this.client.post(endpoint, data);
                    break;
                case 'put':
                    response = await this.client.put(endpoint, data);
                    break;
                case 'delete':
                    response = await this.client.delete(endpoint);
                    break;
            }

            return response.data;
        } catch (error) {
            status = 'failed';
            throw error;
        } finally {
            const duration = (Date.now() - startTime) / 1000;
            lidarrApiCallsTotal.inc({ endpoint, status });
            lidarrApiDuration.observe({ endpoint }, duration);
        }
    }

    /**
     * Ensure the root folder exists in Lidarr, fallback to first available if not
     */
    private async ensureRootFolderExists(
        requestedPath: string
    ): Promise<string> {
        if (!this.client) {
            return requestedPath;
        }

        try {
            // Get all root folders from Lidarr
            const rootFolders = await this.apiCall<LidarrRootFolder[]>("/api/v1/rootfolder", 'get');

            if (rootFolders.length === 0) {
                logger.warn("  No root folders configured in Lidarr!");
                return requestedPath;
            }

            // Check if requested path exists
            const exists = rootFolders.find(
                (folder) => folder.path === requestedPath
            );

            if (exists) {
                return requestedPath;
            }

            // Fallback to first available root folder
            const fallback = rootFolders[0].path;
            logger.debug(`  Root folder "${requestedPath}" not found in Lidarr`);
            logger.debug(`   Using fallback: "${fallback}"`);
            return fallback;
        } catch (error) {
            logger.error("Error checking root folders:", error);
            return requestedPath; // Return requested path and let Lidarr error if needed
        }
    }

    async searchArtist(
        artistName: string,
        mbid?: string
    ): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        logger.debug(
            `[LIDARR_SEARCH_ARTIST] artistName="${artistName}", mbid="${mbid}"`
        );

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            const response = await this.client.get("/api/v1/artist/lookup", {
                params: {
                    term: mbid ? `lidarr:${mbid}` : artistName,
                },
            });

            // If Lidarr's lookup returned results, use them
            if (response.data && response.data.length > 0) {
                return response.data;
            }

            // FALLBACK: Lidarr's metadata server may be having issues
            // If we have an MBID, create a minimal artist object from our own MusicBrainz data
            if (mbid) {
                logger.debug(
                    `   [FALLBACK] Lidarr lookup failed, using direct MusicBrainz data for MBID: ${mbid}`
                );

                try {
                    // Import MusicBrainz service dynamically to avoid circular deps
                    const { musicBrainzService } = await import(
                        "./musicbrainz"
                    );

                    // Get artist info from MusicBrainz directly
                    const mbArtists = await musicBrainzService.searchArtist(
                        artistName,
                        5
                    ) as MusicBrainzArtist[];
                    const mbArtist =
                        mbArtists?.find((a) => a.id === mbid) || mbArtists?.[0];

                    if (mbArtist) {
                        // Create a minimal Lidarr-compatible artist object
                        const fallbackArtist: LidarrArtist = {
                            id: 0, // Will be assigned when added
                            artistName: mbArtist.name || artistName,
                            foreignArtistId: mbid,
                            nameSlug: "",
                            genres: [],
                            links: [],
                            artistType: mbArtist.type || "Person",
                            monitored: false,
                            qualityProfileId: 1,
                            metadataProfileId: 1,
                            rootFolderPath: "/music",
                            tags: [],
                            statistics: {
                                albumCount: 0,
                                trackFileCount: 0,
                                trackCount: 0,
                                totalTrackCount: 0,
                                sizeOnDisk: 0,
                                percentOfTracks: 0
                            },
                        };

                        logger.debug(
                            `   [FALLBACK] Created artist from MusicBrainz: ${fallbackArtist.artistName}`
                        );
                        return [fallbackArtist];
                    }
                } catch (mbError: any) {
                    logger.error(
                        `   [FALLBACK] MusicBrainz lookup also failed:`,
                        mbError.message
                    );
                }
            }

            return response.data || [];
        } catch (error) {
            logger.error("Lidarr artist search error:", error);

            // FALLBACK on error too
            if (mbid) {
                logger.debug(
                    `   [FALLBACK] Lidarr error, trying MusicBrainz for MBID: ${mbid}`
                );
                try {
                    const { musicBrainzService } = await import(
                        "./musicbrainz"
                    );
                    const mbArtists = await musicBrainzService.searchArtist(
                        artistName,
                        5
                    ) as MusicBrainzArtist[];
                    const mbArtist =
                        mbArtists?.find((a) => a.id === mbid) || mbArtists?.[0];

                    if (mbArtist) {
                        const fallbackArtist: LidarrArtist = {
                            id: 0,
                            artistName: mbArtist.name || artistName,
                            foreignArtistId: mbid,
                            nameSlug: "",
                            genres: [],
                            links: [],
                            artistType: mbArtist.type || "Person",
                            monitored: false,
                            qualityProfileId: 1,
                            metadataProfileId: 1,
                            rootFolderPath: "/music",
                            tags: [],
                            statistics: {
                                albumCount: 0,
                                trackFileCount: 0,
                                trackCount: 0,
                                totalTrackCount: 0,
                                sizeOnDisk: 0,
                                percentOfTracks: 0
                            },
                        };
                        logger.debug(
                            `   [FALLBACK] Created artist from MusicBrainz: ${fallbackArtist.artistName}`
                        );
                        return [fallbackArtist];
                    }
                } catch (mbError: any) {
                    logger.error(
                        `   [FALLBACK] MusicBrainz also failed:`,
                        mbError.message
                    );
                }
            }

            return [];
        }
    }

    async addArtist(
        mbid: string,
        artistName: string,
        rootFolderPath: string = "/music",
        searchForMissingAlbums: boolean = true,
        monitorAllAlbums: boolean = true,
        isDiscovery: boolean = false
    ): Promise<LidarrArtist | null> {
        await this.ensureInitialized();

        logger.debug(
            `[LIDARR_ADD_ARTIST] artistName="${artistName}", mbid="${mbid}"`
        );

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        // Get discovery tag ID if this is a discovery add
        let discoveryTagId: number | null = null;
        if (isDiscovery) {
            discoveryTagId = await this.getOrCreateDiscoveryTag();
            if (discoveryTagId) {
                logger.debug(
                    `[LIDARR] Will apply discovery tag (ID: ${discoveryTagId}) to artist`
                );
            }
        }

        try {
            // Ensure root folder exists, fallback to default if not
            const validRootFolder = await this.ensureRootFolderExists(
                rootFolderPath
            );

            logger.debug(
                ` Searching Lidarr for artist: "${artistName}"${
                    mbid ? ` (MBID: ${mbid})` : " (no MBID - using name search)"
                }`
            );
            logger.debug(`   Root folder: ${validRootFolder}`);

            // Search for artist (by MBID if available, otherwise by name)
            const searchResults = await this.searchArtist(artistName, mbid);

            if (searchResults.length === 0) {
                logger.error(` Artist not found in Lidarr: ${artistName}`);
                return null;
            }

            logger.debug(`   Found ${searchResults.length} results from Lidarr`);

            let artistData: LidarrArtist;

            if (mbid) {
                // STRICT MBID FILTERING - Only use exact MBID match
                const exactMatch = searchResults.find(
                    (artist) => artist.foreignArtistId === mbid
                );

                if (!exactMatch) {
                    logger.error(
                        ` No exact MBID match found for: ${artistName} (${mbid})`
                    );
                    logger.debug(
                        "   Available results:",
                        searchResults.map((a) => ({
                            name: a.artistName,
                            mbid: a.foreignArtistId,
                            type: a.artistType,
                        }))
                    );
                    return null;
                }

                // ADDITIONAL CHECK: If exact match is a "Group" with 0 albums,
                // look for a better match with same name but different type
                if (
                    exactMatch.artistType === "Group" &&
                    (exactMatch.statistics?.albumCount || 0) === 0
                ) {
                    logger.debug(
                        ` Exact MBID match is a Group with 0 albums - checking for better match...`
                    );

                    // Look for same artist name but different type with albums
                    const betterMatch = searchResults.find(
                        (artist) =>
                            artist.artistName.toLowerCase() ===
                                exactMatch.artistName.toLowerCase() &&
                            artist.foreignArtistId !== mbid &&
                            (artist.statistics?.albumCount || 0) > 0 &&
                            (artist.artistType === "Person" ||
                                artist.artistType === "Artist")
                    );

                    if (betterMatch) {
                        logger.debug(
                            `   Found better match: "${
                                betterMatch.artistName
                            }" (Type: ${betterMatch.artistType}, Albums: ${
                                betterMatch.statistics?.albumCount || 0
                            })`
                        );
                        artistData = betterMatch;
                    } else {
                        logger.debug(
                            ` No better match found, using Group entry`
                        );
                        artistData = exactMatch;
                    }
                } else {
                    logger.debug(
                        `Exact match found: "${exactMatch.artistName}" (Type: ${
                            exactMatch.artistType
                        }, Albums: ${exactMatch.statistics?.albumCount || 0})`
                    );
                    artistData = exactMatch;
                }
            } else {
                // FALLBACK: No MBID - Use smart filtering for best match
                logger.debug(" No MBID available - using smart selection...");

                // Filter and score results
                const scoredResults = searchResults.map((artist) => {
                    let score = 0;

                    // Prefer "Person" or "Group" types for actual artists
                    const type = (artist.artistType || "").toLowerCase();
                    if (type === "person") score += 1000;
                    else if (type === "group") score += 900;
                    else if (type === "artist") score += 800;

                    // Album count (more albums = more likely correct)
                    const albumCount = artist.statistics?.albumCount || 0;
                    score += albumCount * 10;

                    // Exact name match bonus (case-insensitive)
                    const artistNameNormalized = (artist.artistName || "")
                        .toLowerCase()
                        .trim();
                    const searchNameNormalized = artistName
                        .toLowerCase()
                        .trim();

                    if (artistNameNormalized === searchNameNormalized) {
                        score += 500;
                    } else if (
                        artistNameNormalized.includes(searchNameNormalized) ||
                        searchNameNormalized.includes(artistNameNormalized)
                    ) {
                        score += 250; // Partial match
                    }

                    // Popularity
                    if (artist.ratings?.votes && artist.ratings?.votes > 0) {
                        score += Math.min(artist.ratings.votes / 10, 100);
                    }

                    // Penalize "Various Artists" entries
                    if (
                        artistNameNormalized.includes("various") ||
                        artistNameNormalized.includes("compilation")
                    ) {
                        score -= 1000;
                    }

                    return { artist, score };
                });

                // Sort by score
                scoredResults.sort((a, b) => b.score - a.score);

                // Log candidates for debugging
                logger.debug("   Candidates:");
                scoredResults.slice(0, 3).forEach((item, i) => {
                    logger.debug(
                        `     ${i + 1}. "${item.artist.artistName}" - Type: ${
                            item.artist.artistType || "Unknown"
                        } - Albums: ${
                            item.artist.statistics?.albumCount || 0
                        } - Score: ${item.score}${i === 0 ? " ← SELECTED" : ""}`
                    );
                });

                artistData = scoredResults[0].artist;
            }

            // Check if already exists
            const existingArtists = await this.client.get("/api/v1/artist");
            const exists = existingArtists.data.find(
                (a: LidarrArtist) =>
                    a.foreignArtistId === artistData.foreignArtistId ||
                    (mbid && a.foreignArtistId === mbid)
            );

            if (exists) {
                logger.debug(`Artist already in Lidarr: ${artistName}`);

                // If this is a discovery add and artist doesn't have discovery tag, add it
                if (isDiscovery && discoveryTagId) {
                    const existingTags = exists.tags || [];
                    if (!existingTags.includes(discoveryTagId)) {
                        logger.debug(
                            `   Adding discovery tag to existing artist...`
                        );
                        await this.addTagsToArtist(exists.id, [discoveryTagId]);
                    }
                }

                // If monitorAllAlbums is true, update the artist to monitor all albums
                if (monitorAllAlbums) {
                    logger.debug(`   Updating artist to monitor all albums...`);
                    try {
                        // Update artist settings
                        const updated = await this.client.put(
                            `/api/v1/artist/${exists.id}`,
                            {
                                ...exists,
                                monitored: true,
                                monitorNewItems: "all",
                            }
                        );

                        // Get all albums for this artist and monitor them
                        const albumsResponse = await this.client.get(
                            `/api/v1/album?artistId=${exists.id}`
                        );
                        const albums = albumsResponse.data as LidarrAlbum[];

                        logger.debug(
                            `   Found ${albums.length} albums to monitor`
                        );

                        // Monitor all albums
                        for (const album of albums) {
                            if (!album.monitored) {
                                await this.client.put(
                                    `/api/v1/album/${album.id}`,
                                    {
                                        ...album,
                                        monitored: true,
                                    }
                                );
                            }
                        }

                        // Trigger search for all albums if requested
                        if (searchForMissingAlbums && albums.length > 0) {
                            logger.debug(
                                `   Triggering search for ${albums.length} albums...`
                            );
                            await this.client.post("/api/v1/command", {
                                name: "AlbumSearch",
                                albumIds: albums.map((a) => a.id),
                            });
                        }

                        logger.debug(
                            `   Updated existing artist and monitored all albums`
                        );
                        return updated.data;
                    } catch (error: any) {
                        logger.error(
                            `   Failed to update artist:`,
                            error.message
                        );
                        // Return original artist if update fails
                        return exists;
                    }
                }

                return exists;
            }

            // Add artist - use "existing" monitor option to ensure album catalog is fetched
            // even if we don't want to download all albums
            const artistPayload: LidarrAddArtistRequest = {
                foreignArtistId: artistData.foreignArtistId,
                artistName: artistData.artistName,
                rootFolderPath: validRootFolder,
                qualityProfileId: 1, // Uses default profile - could be made configurable via settings
                metadataProfileId: 1,
                monitored: true,
                monitorNewItems: monitorAllAlbums ? "all" : "none",
                addOptions: {
                    monitor: "existing", // Always fetch album catalog, but don't monitor unless requested
                    searchForMissingAlbums,
                },
            };

            // Apply discovery tag if this is a discovery add
            if (discoveryTagId) {
                artistPayload.tags = [discoveryTagId];
            }

            let response;
            try {
                response = await this.client.post("/api/v1/artist", artistPayload);
            } catch (postError: any) {
                // Handle race condition where artist was added between our check and post
                const errorMsg = postError.response?.data?.[0]?.errorMessage || postError.message || "";
                if (errorMsg.includes("already exists") || errorMsg.includes("UNIQUE constraint failed")) {
                    logger.debug(`   Artist added by another process, fetching existing...`);
                    const artists = await this.client.get("/api/v1/artist");
                    const existing = artists.data.find(
                        (a: LidarrArtist) => a.foreignArtistId === artistData.foreignArtistId
                    );
                    if (existing) return existing;
                }
                throw postError;
            }

            logger.debug(
                `Added artist to Lidarr: ${artistName}${
                    isDiscovery ? " (tagged as discovery)" : ""
                }`
            );

            // Trigger metadata refresh to ensure album catalog is populated
            if (!searchForMissingAlbums) {
                // Add a small delay to let Lidarr's internal state settle
                await new Promise((resolve) => setTimeout(resolve, this.ROOT_FOLDER_CREATE_DELAY));
                
                logger.debug(`   Triggering metadata refresh for new artist...`);
                try {
                    await this.client.post("/api/v1/command", {
                        name: "RefreshArtist",
                        artistId: response.data.id,
                    });
                } catch (refreshError) {
                    logger.warn(
                        `   Metadata refresh command failed (non-blocking)`
                    );
                }
            }

            return response.data;
        } catch (error: any) {
            logger.error(
                "Lidarr add artist error:",
                error.response?.data || error.message
            );
            return null;
        }
    }

    async searchAlbum(
        artistName: string,
        albumTitle: string,
        rgMbid?: string
    ): Promise<LidarrAlbum[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            const searchTerm = rgMbid
                ? `lidarr:${rgMbid}`
                : `${artistName} ${albumTitle}`;
            logger.debug(`   Searching Lidarr for album: ${searchTerm}`);

            const response = await this.client.get("/api/v1/album/lookup", {
                params: {
                    term: searchTerm,
                },
            });

            // If results found, return them
            if (response.data.length > 0) {
                logger.debug(`   Found ${response.data.length} album result(s)`);
                return response.data;
            }

            // If no results and not using MBID, try with stripped album title
            if (!rgMbid) {
                const strippedTitle = stripAlbumEdition(albumTitle);
                if (strippedTitle !== albumTitle && strippedTitle.length > 2) {
                    const fallbackTerm = `${artistName} ${strippedTitle}`;
                    logger.debug(`   No results, trying stripped title: ${fallbackTerm}`);

                    const fallbackResponse = await this.client.get("/api/v1/album/lookup", {
                        params: {
                            term: fallbackTerm,
                        },
                    });

                    if (fallbackResponse.data.length > 0) {
                        logger.debug(`   Found ${fallbackResponse.data.length} result(s) with stripped title`);
                        return fallbackResponse.data;
                    }
                }
            }

            logger.debug(`   Found 0 album result(s)`);
            return response.data;
        } catch (error: any) {
            logger.error(`Lidarr album search error: ${error.message}`);
            if (error.response?.data) {
                logger.error(`   Response:`, error.response.data);
            }
            return [];
        }
    }

    /**
     * Extract base album title by removing edition markers
     * E.g., "Abbey Road (Remastered)" → "Abbey Road"
     * Uses the shared stripAlbumEdition utility for consistency
     */
    private extractBaseTitle(title: string): string {
        return stripAlbumEdition(title);
    }

    /**
     * Get all albums for an artist that exist in Lidarr's catalog
     * Used for same-artist fallback to avoid trying MusicBrainz albums that Lidarr can't find
     */
    async getArtistAlbums(artistMbid: string): Promise<LidarrAlbum[]> {
        if (!this.client) {
            logger.warn("Lidarr not enabled");
            return [];
        }

        try {
            // First find the artist in Lidarr
            const artistsResponse = await this.client.get("/api/v1/artist");
            const artist = artistsResponse.data.find(
                (a: LidarrArtist) => a.foreignArtistId === artistMbid
            );

            if (!artist) {
                logger.debug(`   Artist not found in Lidarr: ${artistMbid}`);
                return [];
            }

            // Get albums for this artist
            const albumsResponse = await this.client.get(
                `/api/v1/album?artistId=${artist.id}`
            );
            return albumsResponse.data || [];
        } catch (error: any) {
            logger.error(`   Failed to get artist albums: ${error.message}`);
            return [];
        }
    }

    /**
     * Wait for a Lidarr command to complete
     * @param commandId The command ID to poll
     * @param timeoutMs Maximum time to wait (default: 30s)
     * @param pollIntervalMs Time between polls (default: 2s)
     * @returns The completed command status
     */
    private async waitForCommand(
        commandId: number,
        timeoutMs: number = this.COMMAND_POLL_TIMEOUT_DEFAULT,
        pollIntervalMs: number = this.COMMAND_POLL_INTERVAL
    ): Promise<{ status: string; message: string }> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const response = await this.client!.get(
                `/api/v1/command/${commandId}`
            );
            const { status, message, body } = response.data;

            // Check if command finished (completed, failed, aborted)
            if (status !== "started" && status !== "queued") {
                logger.debug(
                    `   Command ${commandId} completed with status: ${status}`
                );
                return {
                    status,
                    message: message || body?.records?.[0]?.message || "",
                };
            }

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Command ${commandId} timed out after ${timeoutMs}ms`);
    }

    async addAlbum(
        rgMbid: string,
        artistName: string,
        albumTitle: string,
        rootFolderPath: string = "/music",
        artistMbid?: string,
        isDiscovery: boolean = false
    ): Promise<LidarrAlbum | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            logger.debug(
                `   Adding album: ${albumTitle} by ${artistName}${
                    isDiscovery ? " (discovery)" : ""
                }`
            );
            logger.debug(`   Album MBID: ${rgMbid}`);
            logger.debug(`   Artist MBID: ${artistMbid || "none"}`);

            // NEW APPROACH: Add artist first, then find album in their catalog
            // This avoids the broken external album search API

            // Check if artist exists
            const existingArtists = await this.client.get("/api/v1/artist");
            let artist = existingArtists.data.find(
                (a: LidarrArtist) =>
                    artistMbid && a.foreignArtistId === artistMbid
            );

            let justAddedArtist = false;

            // If discovery and artist exists, ensure they have the discovery tag
            if (isDiscovery && artist) {
                const discoveryTagId = await this.getOrCreateDiscoveryTag();
                if (discoveryTagId) {
                    const existingTags = artist.tags || [];
                    if (!existingTags.includes(discoveryTagId)) {
                        logger.debug(
                            `   Adding discovery tag to existing artist...`
                        );
                        await this.addTagsToArtist(artist.id, [discoveryTagId]);
                    }
                }
            }

            if (!artist && artistMbid) {
                logger.debug(`   Adding artist first: ${artistName}`);

                // Add artist WITHOUT searching for all albums
                // Pass isDiscovery to tag the artist appropriately
                artist = await this.addArtist(
                    artistMbid,
                    artistName,
                    rootFolderPath,
                    false, // Don't auto-download all albums
                    false, // Don't monitor all albums
                    isDiscovery // Tag as discovery if this is a discovery download
                );

                if (!artist) {
                    logger.error(` Failed to add artist`);
                    return null;
                }

                justAddedArtist = true;
                logger.debug(
                    `   Artist added: ${artist.artistName} (ID: ${artist.id})`
                );
                logger.debug(
                    `   Waiting for Lidarr to populate album catalog...`
                );
            } else if (!artist) {
                logger.error(` Artist not found and no MBID provided`);
                return null;
            } else {
                logger.debug(
                    `   Artist already exists: ${artist.artistName} (ID: ${artist.id})`
                );
            }

            // Get artist's albums from Lidarr
            let artistAlbums: LidarrAlbum[] = [];

            // First check - get current album list
            const artistAlbumsResponse = await this.client.get(
                `/api/v1/album?artistId=${artist.id}`
            );
            artistAlbums = artistAlbumsResponse.data;

            // If we just added the artist and no albums yet, wait for metadata to populate
            if (artistAlbums.length === 0 && justAddedArtist) {
                logger.debug(`   Waiting for Lidarr to fetch album metadata...`);

                // Increased timeout: 20 attempts * 3 seconds = 60 seconds total
                // Large artist catalogs (e.g., prolific bands) need more time
                const maxAttempts = this.METADATA_FETCH_MAX_ATTEMPTS;
                const retryDelay = this.METADATA_FETCH_DELAY; // 3 seconds between retries

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, retryDelay)
                    );

                    const retryResponse = await this.client.get(
                        `/api/v1/album?artistId=${artist.id}`
                    );
                    artistAlbums = retryResponse.data;

                    if (artistAlbums.length > 0) {
                        logger.debug(`   Albums loaded after ${attempt * (this.METADATA_FETCH_DELAY / 1000)}s`);
                        break;
                    }

                    if (attempt < maxAttempts) {
                        logger.debug(
                            `   Attempt ${attempt}/${maxAttempts}: Still waiting...`
                        );
                    } else {
                        logger.warn(
                            ` Timeout reached after ${
                                (maxAttempts * this.METADATA_FETCH_DELAY) / 1000
                            }s - artist catalog may still be populating`
                        );
                    }
                }
            } else if (artistAlbums.length === 0 && !justAddedArtist) {
                // Artist exists but has 0 albums - try refreshing metadata once
                logger.debug(
                    `   Artist exists but has 0 albums - refreshing metadata...`
                );
                try {
                    await this.client.post("/api/v1/command", {
                        name: "RefreshArtist",
                        artistId: artist.id,
                    });
                    // Wait for refresh to complete
                    await new Promise((resolve) => setTimeout(resolve, 5000));

                    const retryResponse = await this.client.get(
                        `/api/v1/album?artistId=${artist.id}`
                    );
                    artistAlbums = retryResponse.data;
                } catch (refreshError) {
                    logger.warn(`   Metadata refresh failed`);
                }
            }

            logger.debug(
                `   Found ${artistAlbums.length} albums for ${artist.artistName}`
            );

            // Find the specific album by MBID first
            let albumData = artistAlbums.find(
                (a: LidarrAlbum) => a.foreignAlbumId === rgMbid
            );

            // If MBID doesn't match, try STRICT name matching
            // IMPORTANT: We removed loose matching (base name, first word) because it caused
            // wrong albums to be downloaded (e.g., "A Trip To The Mystery Planet" matching "A Funk Odyssey")
            if (!albumData) {
                logger.debug(
                    `   Album MBID not found, trying STRICT name match for: ${albumTitle}`
                );

                // Normalize title for matching - remove parenthetical suffixes, edition markers, etc.
                const normalizeTitle = (title: string) =>
                    title
                        .toLowerCase()
                        .replace(/\(.*?\)/g, "") // Remove parenthetical content (deluxe edition, remaster, etc.)
                        .replace(/\[.*?\]/g, "") // Remove bracketed content
                        .replace(
                            /[-–—]\s*(deluxe|remaster|bonus|special|anniversary|expanded|limited|collector).*$/i,
                            ""
                        ) // Remove edition suffixes
                        .replace(/[^\w\s]/g, "") // Remove remaining punctuation
                        .replace(/\s+/g, " ") // Normalize whitespace
                        .trim();

                const targetTitle = normalizeTitle(albumTitle);
                logger.debug(`   Normalized target: "${targetTitle}"`);

                // Try exact normalized match first
                albumData = artistAlbums.find(
                    (a: LidarrAlbum) => normalizeTitle(a.title) === targetTitle
                );
                if (albumData) {
                    logger.debug(
                        ` Matched exact normalized: "${albumData.title}"`
                    );
                }

                // Try partial match ONLY if one contains the other completely
                // This handles "Album Name" matching "Album Name (Deluxe Edition)"
                if (!albumData) {
                    albumData = artistAlbums.find((a: LidarrAlbum) => {
                        const normalized = normalizeTitle(a.title);
                        // Only match if one is a substring of the other AND they share significant content
                        // The shorter one must be at least 60% of the longer one's length
                        const shorter =
                            normalized.length < targetTitle.length
                                ? normalized
                                : targetTitle;
                        const longer =
                            normalized.length >= targetTitle.length
                                ? normalized
                                : targetTitle;
                        if (
                            longer.includes(shorter) &&
                            shorter.length >= longer.length * 0.6
                        ) {
                            return true;
                        }
                        return false;
                    });
                    if (albumData) {
                        logger.debug(
                            ` Matched partial (contained): "${albumData.title}"`
                        );
                    }
                }

                // NO base name matching - this caused wrong albums to be matched
                // NO first word matching - this caused wrong albums to be matched
                // If we don't have an exact or contained match, we should FAIL
                // and let the discovery system find a different album

                if (albumData) {
                    logger.debug(
                        `   Final match: "${albumData.title}" (MBID: ${albumData.foreignAlbumId})`
                    );
                } else {
                    logger.debug(
                        ` No strict match found - will NOT use loose matching to avoid wrong albums`
                    );
                }
            }

            if (!albumData) {
                logger.error(
                    `   ✗ Album "${albumTitle}" not found in artist's ${artistAlbums.length} albums`
                );
                if (artistAlbums.length > 0) {
                    logger.debug(
                        `   Looking for: "${albumTitle}" (MBID: ${rgMbid})`
                    );
                    logger.debug(
                        `   Available albums in Lidarr (showing up to 10):`
                    );
                    artistAlbums.slice(0, 10).forEach((a: LidarrAlbum) => {
                        logger.debug(
                            `     - "${a.title}" (${a.foreignAlbumId})`
                        );
                    });
                }
                // Throw structured error - allows fallback to Soulseek
                throw new AcquisitionError(
                    `Album "${albumTitle}" not found in Lidarr catalog for ${artistName}`,
                    AcquisitionErrorType.ALBUM_NOT_FOUND,
                    true // isRecoverable - Soulseek can try
                );
            }

            logger.debug(
                `   Found album in catalog: ${albumData.title} (ID: ${albumData.id})`
            );

            // Ensure artist is monitored (might have been added with monitoring disabled)
            if (!artist.monitored) {
                logger.debug(`   Enabling artist monitoring...`);
                await this.client.put(`/api/v1/artist/${artist.id}`, {
                    ...artist,
                    monitored: true,
                });
                logger.debug(`   Artist monitoring enabled`);
            } else {
                logger.debug(`   Artist already monitored`);
            }

            // CRITICAL: Fetch the FULL album data from Lidarr
            // The album list endpoint may return incomplete data
            logger.debug(`   Fetching full album data from Lidarr...`);
            const fullAlbumResponse = await this.client.get(
                `/api/v1/album/${albumData.id}`
            );
            const fullAlbumData = fullAlbumResponse.data;

            logger.debug(
                `   Full album data retrieved:`,
                JSON.stringify(
                    {
                        id: fullAlbumData.id,
                        title: fullAlbumData.title,
                        monitored: fullAlbumData.monitored,
                        foreignAlbumId: fullAlbumData.foreignAlbumId,
                        anyReleaseOk: fullAlbumData.anyReleaseOk,
                        profileId: fullAlbumData.profileId,
                        releases: fullAlbumData.releases?.length || 0,
                    },
                    null,
                    2
                )
            );

            // ALWAYS monitor and search for the album, even if already monitored
            // This ensures Lidarr picks up the request
            // Preserve user's anyReleaseOk setting - we'll only change it if search fails later
            logger.debug(`   Setting album monitoring to true...`);

            const updateResponse = await this.client.put(
                `/api/v1/album/${fullAlbumData.id}`,
                {
                    ...fullAlbumData,
                    monitored: true,
                }
            );

            logger.debug(
                `   PUT response monitored: ${updateResponse.data.monitored}`
            );

            // CRITICAL: Re-fetch the album to verify the change actually persisted
            const verifyResponse = await this.client.get(
                `/api/v1/album/${fullAlbumData.id}`
            );
            const verifiedMonitored = verifyResponse.data.monitored;

            logger.debug(
                `   Album monitoring VERIFIED after re-fetch: ${verifiedMonitored}`
            );

            if (!verifiedMonitored) {
                logger.error(` CRITICAL: Album monitoring failed to persist!`);
                logger.error(
                    `   Full album data we sent:`,
                    JSON.stringify(fullAlbumData, null, 2).slice(0, 500)
                );
                logger.error(
                    `   Response from GET after PUT:`,
                    JSON.stringify(verifyResponse.data, null, 2).slice(0, 500)
                );
            }

            // Use the verified album data
            const updatedAlbum = verifyResponse.data;

            const editionPatterns = [
                /\(remaster/i,
                /\(deluxe/i,
                /\(expanded/i,
                /\(anniversary/i,
                /\(bonus/i,
                /\(special/i,
                /\(limited/i,
                /\(collector/i,
                /\(super deluxe/i,
                /\(platinum/i,
                /\(japan/i,
                /\(uk/i,
                /\(us/i,
                /\(import/i,
                /\[remaster/i,
                /\[deluxe/i,
            ];
            const isEditionVariant = editionPatterns.some((p) =>
                p.test(albumTitle)
            );
            const foundAlbumIsEdition = editionPatterns.some((p) =>
                p.test(updatedAlbum.title || "")
            );
            const needsAnyReleaseOk = isEditionVariant || foundAlbumIsEdition;

            if (needsAnyReleaseOk && !updatedAlbum.anyReleaseOk) {
                logger.debug(
                    `   Edition variant detected ("${albumTitle}") - enabling anyReleaseOk proactively`
                );

                await this.client.put(`/api/v1/album/${updatedAlbum.id}`, {
                    ...updatedAlbum,
                    anyReleaseOk: true,
                });

                updatedAlbum.anyReleaseOk = true;
                logger.debug(
                    `   anyReleaseOk enabled - Lidarr will accept any release of this album`
                );
            }

            // Check if album has releases - if not, refresh artist metadata from MusicBrainz
            const releaseCount = updatedAlbum.releases?.length || 0;
            if (releaseCount === 0) {
                logger.warn(
                    ` Album has 0 releases - refreshing artist metadata from MusicBrainz...`
                );

                // Trigger artist refresh to fetch latest metadata
                await this.client.post("/api/v1/command", {
                    name: "RefreshArtist",
                    artistId: artist.id,
                });

                logger.debug(`   Waiting for metadata refresh to complete...`);
                // Wait for refresh to complete (Lidarr processes this asynchronously)
                await new Promise((resolve) => setTimeout(resolve, 5000));

                // Re-fetch the album to see if releases were populated
                const refreshedAlbumResponse = await this.client.get(
                    `/api/v1/album/${updatedAlbum.id}`
                );
                const refreshedAlbum = refreshedAlbumResponse.data;
                const newReleaseCount = refreshedAlbum.releases?.length || 0;

                logger.debug(
                    `   After refresh: ${newReleaseCount} releases found`
                );

                if (newReleaseCount === 0) {
                    logger.warn(` Still no releases after refresh!`);
                    logger.warn(
                        `   This album may not be properly indexed in MusicBrainz yet.`
                    );
                    logger.warn(`   Download will be attempted but may fail.`);
                }
            }

            // ALWAYS trigger search to download the album
            logger.debug(
                `   Triggering album search command for album ID ${updatedAlbum.id}...`
            );
            const searchResponse = await this.client.post("/api/v1/command", {
                name: "AlbumSearch",
                albumIds: [updatedAlbum.id],
            });
            logger.debug(
                `   Search command sent (Command ID: ${searchResponse.data.id})`
            );

            // Wait for search to complete (with 30s timeout)
            try {
                const result = await this.waitForCommand(
                    searchResponse.data.id
                );

                if (result.message?.includes("0 reports")) {
                    try {
                        const albumDetails = await this.client.get(
                            `/api/v1/album/${updatedAlbum.id}`
                        );
                        const releaseCount =
                            albumDetails.data.releases?.length || 0;
                        const anyReleaseOkStatus =
                            albumDetails.data.anyReleaseOk;

                        logger.debug(
                            `   [DIAGNOSTIC] Initial search returned 0 reports`
                        );
                        logger.debug(
                            `   [DIAGNOSTIC] Album "${updatedAlbum.title}" has ${releaseCount} releases defined in Lidarr`
                        );
                        logger.debug(
                            `   [DIAGNOSTIC] anyReleaseOk: ${anyReleaseOkStatus}`
                        );
                        logger.debug(
                            `   [DIAGNOSTIC] Album MBID: ${updatedAlbum.foreignAlbumId}`
                        );

                        if (releaseCount === 0) {
                            logger.warn(
                                `   [DIAGNOSTIC] ⚠️ Album has 0 releases in Lidarr - metadata may be incomplete`
                            );
                        }

                        if (!this._indexerCountLogged) {
                            try {
                                const indexers = await this.client.get(
                                    "/api/v1/indexer"
                                );
                                const enabledIndexers = indexers.data.filter(
                                    (i: any) =>
                                        i.enableRss || i.enableAutomaticSearch
                                );
                                logger.debug(
                                    `   [DIAGNOSTIC] ${enabledIndexers.length} enabled indexers configured in Lidarr`
                                );

                                if (enabledIndexers.length === 0) {
                                    logger.error(
                                        `   [DIAGNOSTIC] ❌ No enabled indexers - Lidarr cannot search for releases`
                                    );
                                }
                                this._indexerCountLogged = true;
                            } catch (indexerError) {
                                // Ignore indexer check errors
                            }
                        }
                    } catch (diagError) {
                        // Ignore diagnostic errors
                    }

                    // No sources found - try anyReleaseOk if not already enabled
                    if (!updatedAlbum.anyReleaseOk) {
                        logger.debug(
                            `   No results with strict matching. Trying anyReleaseOk=true...`
                        );

                        // Enable anyReleaseOk and retry
                        await this.client.put(
                            `/api/v1/album/${updatedAlbum.id}`,
                            {
                                ...updatedAlbum,
                                anyReleaseOk: true,
                            }
                        );

                        const retryResponse = await this.client.post(
                            "/api/v1/command",
                            {
                                name: "AlbumSearch",
                                albumIds: [updatedAlbum.id],
                            }
                        );

                        const retryResult = await this.waitForCommand(
                            retryResponse.data.id
                        );

                        if (retryResult.message?.includes("0 reports")) {
                            const baseAlbumTitle = this.extractBaseTitle(albumTitle);

                            if (baseAlbumTitle !== albumTitle && baseAlbumTitle.length > 2) {
                                logger.debug(
                                    `   Trying base album title fallback: "${albumTitle}" → "${baseAlbumTitle}"`
                                );

                                const normalizeForMatch = (s: string) =>
                                    s.toLowerCase().replace(/[^\w\s]/g, "").trim();
                                const normalizedBase = normalizeForMatch(baseAlbumTitle);

                                const baseMatch = artistAlbums.find((a: LidarrAlbum) => {
                                    const normalizedAlbumTitle = normalizeForMatch(a.title);

                                    if (normalizedAlbumTitle === normalizedBase) return true;

                                    const shorter =
                                        normalizedAlbumTitle.length < normalizedBase.length
                                            ? normalizedAlbumTitle
                                            : normalizedBase;
                                    const longer =
                                        normalizedAlbumTitle.length >= normalizedBase.length
                                            ? normalizedAlbumTitle
                                            : normalizedBase;
                                    if (
                                        longer.includes(shorter) &&
                                        shorter.length >= longer.length * 0.7
                                    ) {
                                        return true;
                                    }

                                    return false;
                                });

                                if (baseMatch && baseMatch.id !== updatedAlbum.id) {
                                    logger.debug(
                                        `   Found base album: "${baseMatch.title}" (ID: ${baseMatch.id})`
                                    );
                                    logger.debug(`   Attempting download of base album instead...`);

                                    await this.client.put(`/api/v1/album/${baseMatch.id}`, {
                                        ...baseMatch,
                                        monitored: true,
                                        anyReleaseOk: true,
                                    });

                                    const baseSearchResponse = await this.client.post(
                                        "/api/v1/command",
                                        {
                                            name: "AlbumSearch",
                                            albumIds: [baseMatch.id],
                                        }
                                    );

                                    try {
                                        const baseResult = await this.waitForCommand(
                                            baseSearchResponse.data.id
                                        );

                                        if (baseResult.message?.includes("0 reports")) {
                                            logger.warn(
                                                `   Base album "${baseMatch.title}" also has no releases`
                                            );
                                            throw new Error(
                                                `No releases available for "${albumTitle}" or base album "${baseMatch.title}" - ` +
                                                    `check indexer configuration and album availability`
                                            );
                                        }

                                        logger.debug(`   Base album download started: ${baseMatch.title}`);
                                        return baseMatch;
                                    } catch (baseError: any) {
                                        if (baseError.message?.includes("No releases")) {
                                            throw baseError;
                                        }
                                        if (baseError.message?.includes("timed out")) {
                                            logger.warn(
                                                `   Base album search timed out, may still be searching`
                                            );
                                            return baseMatch;
                                        }
                                        throw baseError;
                                    }
                                } else {
                                    logger.debug(
                                        `   No base album match found in artist catalog (${artistAlbums.length} albums)`
                                    );
                                }
                            }

                            throw new AcquisitionError(
                                `No releases available for "${albumTitle}" - indexers found no matching downloads. ` +
                                    `Album may not be available on configured indexers, or MBID mismatch between Lidarr and indexers.`,
                                AcquisitionErrorType.NO_RELEASES_AVAILABLE,
                                true
                            );
                        }
                    } else {
                        throw new Error(
                            "No releases available - indexers found no matching downloads"
                        );
                    }
                }

                logger.debug(`   Album download started: ${updatedAlbum.title}`);
                return updatedAlbum;
            } catch (error: any) {
                if (error.message?.includes("No releases available")) {
                    throw error; // Re-throw for startDownload to handle
                }
                if (error.message?.includes("timed out")) {
                    // Command timed out - album might still be searching
                    logger.warn(
                        `   Search command timed out, album may still be searching`
                    );
                    return updatedAlbum; // Return album, let timeout handling catch it later
                }
                throw error;
            }
        } catch (error: any) {
            // Re-throw our own errors (like "No releases available")
            if (error.message?.includes("No releases available")) {
                throw error;
            }
            logger.error(
                "Lidarr add album error:",
                error.response?.data || error.message
            );
            return null;
        }
    }

    async rescanLibrary(): Promise<void> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            await this.client.post("/api/v1/command", {
                name: "RescanFolders",
            });

            logger.debug("Triggered Lidarr library rescan");
        } catch (error) {
            logger.error("Lidarr rescan error:", error);
            throw error;
        }
    }

    async getArtists(): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            const response = await this.client.get("/api/v1/artist");
            return response.data;
        } catch (error) {
            logger.error("Lidarr get artists error:", error);
            return [];
        }
    }

    /**
     * Delete an artist from Lidarr by MusicBrainz ID
     * This removes the artist and optionally deletes files
     */
    async deleteArtist(
        mbid: string,
        deleteFiles: boolean = true
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return {
                success: false,
                message: "Lidarr not enabled or configured",
            };
        }

        if (!mbid || mbid.startsWith("temp-")) {
            return { success: false, message: "Invalid or temporary MBID" };
        }

        try {
            // Find artist in Lidarr by foreignArtistId (MBID)
            const artists = await this.getArtists();
            const lidarrArtist = artists.find(
                (a) => a.foreignArtistId === mbid
            );

            if (!lidarrArtist) {
                logger.debug(
                    `[LIDARR] Artist with MBID ${mbid} not found in Lidarr`
                );
                return {
                    success: true,
                    message:
                        "Artist not in Lidarr (already removed or never added)",
                };
            }

            logger.debug(
                `[LIDARR] Deleting artist: ${lidarrArtist.artistName} (ID: ${lidarrArtist.id})`
            );

            // Delete the artist from Lidarr (with timeout to prevent hanging)
            await this.client.delete(`/api/v1/artist/${lidarrArtist.id}`, {
                params: {
                    deleteFiles: deleteFiles,
                    addImportListExclusion: false,
                },
                timeout: this.API_TIMEOUT_DEFAULT, // 30 second timeout
            });

            logger.debug(
                `[LIDARR] Successfully deleted artist: ${lidarrArtist.artistName}`
            );
            return {
                success: true,
                message: `Deleted ${lidarrArtist.artistName} from Lidarr`,
            };
        } catch (error: any) {
            logger.error(
                "[LIDARR] Delete artist error:",
                error?.message || error
            );
            return {
                success: false,
                message: error?.message || "Failed to delete from Lidarr",
            };
        }
    }

    /**
     * Delete an album from Lidarr by Lidarr album ID
     * This unmonitors the album and optionally deletes files
     */
    async deleteAlbum(
        lidarrAlbumId: number,
        deleteFiles: boolean = true
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return {
                success: false,
                message: "Lidarr not enabled or configured",
            };
        }

        try {
            logger.debug(`[LIDARR] Deleting album ID: ${lidarrAlbumId}`);

            // First get the album to check for track files
            const albumResponse = await this.client.get(
                `/api/v1/album/${lidarrAlbumId}`
            );
            const album = albumResponse.data;
            const artistId = album.artistId;
            const albumTitle = album.title || "Unknown";

            if (deleteFiles) {
                // Get track files for this album
                const trackFilesResponse = await this.client.get(
                    "/api/v1/trackFile",
                    {
                        params: { albumId: lidarrAlbumId },
                    }
                );

                const trackFiles = trackFilesResponse.data;

                if (trackFiles && trackFiles.length > 0) {
                    // Delete each track file
                    for (const trackFile of trackFiles) {
                        try {
                            await this.client.delete(
                                `/api/v1/trackFile/${trackFile.id}`
                            );
                        } catch (e) {
                            // Ignore individual file deletion errors
                        }
                    }
                    logger.debug(
                        `[LIDARR] Deleted ${trackFiles.length} track files for album: ${albumTitle}`
                    );
                }
            }

            // Unmonitor the album (don't delete the album record, just unmonitor)
            await this.client.put(`/api/v1/album/${lidarrAlbumId}`, {
                ...album,
                monitored: false,
            });

            logger.debug(
                `[LIDARR] Successfully unmonitored album: ${albumTitle}`
            );
            return {
                success: true,
                message: `Deleted files and unmonitored ${albumTitle}`,
            };
        } catch (error: any) {
            logger.error(
                "[LIDARR] Delete album error:",
                error?.message || error
            );
            return {
                success: false,
                message: error?.message || "Failed to delete album from Lidarr",
            };
        }
    }

    /**
     * Check if an album exists in Lidarr and has files (already downloaded)
     * Returns true if the album is already available in Lidarr
     */
    async isAlbumAvailable(albumMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            // Search for the album by MBID
            const response = await this.client.get("/api/v1/album", {
                params: { foreignAlbumId: albumMbid },
            });

            const albums = response.data;
            if (!albums || albums.length === 0) {
                return false;
            }

            // Check if any matching album has files (statistics.percentOfTracks > 0)
            for (const album of albums) {
                if (album.foreignAlbumId === albumMbid) {
                    // Album exists in Lidarr - check if it has files
                    const hasFiles = album.statistics?.percentOfTracks > 0;
                    if (hasFiles) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error: any) {
            // If 404 or other error, album doesn't exist
            if (error.response?.status === 404) {
                return false;
            }
            logger.error("Lidarr album check error:", error.message);
            return false;
        }
    }

    /**
     * Check if an album exists in Lidarr by artist name and album title
     * Handles MBID mismatches between MusicBrainz and Lidarr
     */
    async isAlbumAvailableByTitle(
        artistName: string,
        albumTitle: string
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        const normalizedArtist = artistName.toLowerCase().trim();
        const normalizedAlbum = albumTitle.toLowerCase().trim();

        try {
            // Get all artists from Lidarr
            const artistsResponse = await this.client.get("/api/v1/artist");
            const artists = (artistsResponse.data || []) as LidarrArtist[];

            // Find matching artist by name
            const matchingArtist = artists.find(
                (a) =>
                    a.artistName?.toLowerCase().trim() === normalizedArtist
            );

            if (!matchingArtist) {
                return false;
            }

            // Get albums for this artist
            const albumsResponse = await this.client.get("/api/v1/album", {
                params: { artistId: matchingArtist.id },
            });
            const albums = albumsResponse.data || [];

            // Check if any album matches the title and has files
            for (const album of albums) {
                const albumTitleNorm = album.title?.toLowerCase().trim() || "";
                if (
                    albumTitleNorm === normalizedAlbum ||
                    albumTitleNorm.includes(normalizedAlbum)
                ) {
                    const hasFiles = album.statistics?.percentOfTracks > 0;
                    if (hasFiles) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error: any) {
            logger.error("Lidarr album check by title error:", error.message);
            return false;
        }
    }

    /**
     * Check if an artist exists in Lidarr
     */
    async isArtistInLidarr(artistMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const response = await this.client.get("/api/v1/artist");
            const artists = response.data as LidarrArtist[];
            return artists.some((a) => a.foreignArtistId === artistMbid);
        } catch (error) {
            return false;
        }
    }

    /**
     * Get all tags from Lidarr
     */
    async getTags(): Promise<LidarrTag[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            const response = await this.client.get("/api/v1/tag");
            return response.data || [];
        } catch (error: any) {
            logger.error("[LIDARR] Failed to get tags:", error.message);
            return [];
        }
    }

    /**
     * Create a new tag in Lidarr
     */
    async createTag(label: string): Promise<LidarrTag | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return null;
        }

        try {
            const response = await this.client.post("/api/v1/tag", { label });
            logger.debug(
                `[LIDARR] Created tag: ${label} (ID: ${response.data.id})`
            );
            return response.data;
        } catch (error: any) {
            logger.error("[LIDARR] Failed to create tag:", error.message);
            return null;
        }
    }

    /**
     * Get or create the discovery tag
     * Returns the tag ID, caching it for subsequent calls
     */
    private discoveryTagId: number | null = null;
    private _indexerCountLogged: boolean = false;

    async getOrCreateDiscoveryTag(): Promise<number | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return null;
        }

        // Return cached tag ID if available
        if (this.discoveryTagId !== null) {
            return this.discoveryTagId;
        }

        try {
            // Check if tag already exists
            const tags = await this.getTags();
            const existingTag = tags.find(
                (t) => t.label === DISCOVERY_TAG_LABEL
            );

            if (existingTag) {
                logger.debug(
                    `[LIDARR] Found existing discovery tag (ID: ${existingTag.id})`
                );
                this.discoveryTagId = existingTag.id;
                return existingTag.id;
            }

            // Create the tag
            const newTag = await this.createTag(DISCOVERY_TAG_LABEL);
            if (newTag) {
                this.discoveryTagId = newTag.id;
                return newTag.id;
            }

            return null;
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to get/create discovery tag:",
                error.message
            );
            return null;
        }
    }

    /**
     * Add tags to an artist
     */
    async addTagsToArtist(
        artistId: number,
        tagIds: number[]
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            // Get current artist data
            const response = await this.client.get(
                `/api/v1/artist/${artistId}`
            );
            const artist = response.data;

            // Merge new tags with existing (avoid duplicates)
            const existingTags = artist.tags || [];
            const mergedTags = [...new Set([...existingTags, ...tagIds])];

            // Update artist with new tags
            await this.client.put(`/api/v1/artist/${artistId}`, {
                ...artist,
                tags: mergedTags,
            });

            logger.debug(
                `[LIDARR] Added tags ${tagIds} to artist ${artist.artistName}`
            );
            return true;
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to add tags to artist:",
                error.message
            );
            return false;
        }
    }

    /**
     * Remove tags from an artist
     */
    async removeTagsFromArtist(
        artistId: number,
        tagIds: number[]
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            // Get current artist data
            const response = await this.client.get(
                `/api/v1/artist/${artistId}`
            );
            const artist = response.data;

            // Remove specified tags
            const existingTags = artist.tags || [];
            const filteredTags = existingTags.filter(
                (t: number) => !tagIds.includes(t)
            );

            // Update artist with filtered tags
            await this.client.put(`/api/v1/artist/${artistId}`, {
                ...artist,
                tags: filteredTags,
            });

            logger.debug(
                `[LIDARR] Removed tags ${tagIds} from artist ${artist.artistName}`
            );
            return true;
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to remove tags from artist:",
                error.message
            );
            return false;
        }
    }

    /**
     * Get all artists that have a specific tag
     */
    async getArtistsByTag(tagId: number): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            const response = await this.client.get("/api/v1/artist");
            const artists: LidarrArtist[] = response.data;

            // Filter artists that have the specified tag
            return artists.filter((artist) => artist.tags?.includes(tagId));
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to get artists by tag:",
                error.message
            );
            return [];
        }
    }

    /**
     * Get all discovery-tagged artists (convenience method)
     */
    async getDiscoveryArtists(): Promise<LidarrArtist[]> {
        const tagId = await this.getOrCreateDiscoveryTag();
        if (!tagId) {
            return [];
        }
        return this.getArtistsByTag(tagId);
    }

    /**
     * Remove discovery tag from an artist by MBID
     * Used when user likes an album (artist becomes "owned")
     */
    async removeDiscoveryTagByMbid(artistMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const tagId = await this.getOrCreateDiscoveryTag();
            if (!tagId) {
                return false;
            }

            // Find artist by MBID
            const artists = await this.getArtists();
            const artist = artists.find(
                (a) => a.foreignArtistId === artistMbid
            );

            if (!artist) {
                logger.debug(
                    `[LIDARR] Artist ${artistMbid} not found in Lidarr`
                );
                return true; // Not an error - artist might not be in Lidarr
            }

            // Check if artist has the discovery tag
            if (!artist.tags?.includes(tagId)) {
                logger.debug(
                    `[LIDARR] Artist ${artist.artistName} doesn't have discovery tag`
                );
                return true; // Already doesn't have tag
            }

            return await this.removeTagsFromArtist(artist.id, [tagId]);
        } catch (error: any) {
            logger.error(
                "[LIDARR] Failed to remove discovery tag:",
                error.message
            );
            return false;
        }
    }

    /**
     * Delete artist by Lidarr ID (used for cleanup)
     */
    async deleteArtistById(
        lidarrId: number,
        deleteFiles: boolean = true
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return { success: false, message: "Lidarr not enabled" };
        }

        try {
            await this.client.delete(`/api/v1/artist/${lidarrId}`, {
                params: {
                    deleteFiles,
                    addImportListExclusion: false,
                },
                timeout: this.API_TIMEOUT_DEFAULT,
            });

            return { success: true, message: "Artist deleted" };
        } catch (error: any) {
            if (error.response?.status === 404) {
                return { success: true, message: "Artist already removed" };
            }
            logger.error("[LIDARR] Delete artist by ID error:", error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * Get all available releases for an album from all indexers
     * This is what Lidarr's "Interactive Search" uses
     */
    async getAlbumReleases(lidarrAlbumId: number): Promise<LidarrIndexerRelease[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            logger.debug(
                `[LIDARR] Fetching releases for album ID: ${lidarrAlbumId}`
            );
            const response = await this.client.get("/api/v1/release", {
                params: { albumId: lidarrAlbumId },
                timeout: this.API_TIMEOUT_INDEXER_SEARCH, // 60s timeout for indexer searches
            });

            const releases: LidarrIndexerRelease[] = response.data || [];
            logger.debug(
                `[LIDARR] Found ${releases.length} releases from indexers`
            );

            // Sort by preferred criteria (Lidarr already sorts by quality/preferred words)
            // but we can add seeders as a secondary sort for torrents
            releases.sort((a, b) => {
                // Approved releases first
                if (a.approved && !b.approved) return -1;
                if (!a.approved && b.approved) return 1;

                // Higher seeders for torrents
                if (a.seeders !== undefined && b.seeders !== undefined) {
                    return b.seeders - a.seeders;
                }

                // Keep original order (Lidarr's quality sorting)
                return 0;
            });

            return releases;
        } catch (error: any) {
            logger.error(`[LIDARR] Failed to fetch releases:`, error.message);
            return [];
        }
    }

    /**
     * Grab (download) a specific release by GUID
     * This tells Lidarr to download the specified release
     */
    async grabRelease(release: LidarrIndexerRelease): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            logger.debug(`[LIDARR] Grabbing release: ${release.title}`);
            logger.debug(`   GUID: ${release.guid}`);
            logger.debug(`   Indexer: ${release.indexer || "unknown"}`);
            logger.debug(
                `   Size: ${Math.round((release.size || 0) / 1024 / 1024)} MB`
            );

            await this.client.post("/api/v1/release", {
                guid: release.guid,
                indexerId: release.indexerId || 0,
            });

            logger.debug(`[LIDARR] Release grabbed successfully`);
            return true;
        } catch (error: any) {
            logger.error(
                `[LIDARR] Failed to grab release:`,
                error.response?.data || error.message
            );
            return false;
        }
    }

    /**
     * Remove a download from queue and blocklist the release
     * Use skipRedownload=true since we'll manually grab the next release
     */
    async blocklistAndRemove(downloadId: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            // Find the queue item by downloadId
            const queueResponse = await this.client.get("/api/v1/queue", {
                params: { page: 1, pageSize: 100 },
            });

            const queueData = queueResponse.data as LidarrQueueResponse;
            const queueItem = queueData.records.find(
                (item) => item.downloadId === downloadId
            );

            if (!queueItem) {
                logger.debug(
                    `[LIDARR] Download ${downloadId} not found in queue (may already be removed)`
                );
                return true; // Consider it success if not in queue
            }

            logger.debug(
                `[LIDARR] Blocklisting and removing: ${queueItem.title}`
            );

            await this.client.delete(`/api/v1/queue/${queueItem.id}`, {
                params: {
                    removeFromClient: true,
                    blocklist: true,
                    skipRedownload: true, // We'll grab the next release manually
                },
            });

            logger.debug(
                `[LIDARR] Successfully blocklisted: ${queueItem.title}`
            );
            return true;
        } catch (error: any) {
            logger.error(
                `[LIDARR] Failed to blocklist:`,
                error.response?.data || error.message
            );
            return false;
        }
    }

    /**
     * Find queue item by download ID
     */
    async findQueueItemByDownloadId(downloadId: string): Promise<LidarrQueueItem | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return null;
        }

        try {
            const response = await this.client.get("/api/v1/queue", {
                params: { page: 1, pageSize: 100 },
            });

            const queueData = response.data as LidarrQueueResponse;
            return (
                queueData.records.find(
                    (item) => item.downloadId === downloadId
                ) || null
            );
        } catch (error: any) {
            logger.error(`[LIDARR] Failed to find queue item:`, error.message);
            return null;
        }
    }

    /**
     * Get upcoming and recent releases from Lidarr calendar
     * Returns albums releasing within the specified date range for monitored artists
     */
    async getCalendar(
        startDate: Date,
        endDate: Date
    ): Promise<CalendarRelease[]> {
        await this.ensureInitialized();

        if (!this.client) {
            logger.debug("[LIDARR] Not configured - cannot fetch calendar");
            return [];
        }

        try {
            const start = startDate.toISOString().split("T")[0];
            const end = endDate.toISOString().split("T")[0];

            const response = await this.client.get(`/api/v1/calendar`, {
                params: {
                    start,
                    end,
                    includeArtist: true,
                },
            });

            const albums = response.data as LidarrAlbum[];
            const releases: CalendarRelease[] = albums.map(
                (album) => ({
                    id: album.id,
                    title: album.title,
                    artistName: album.artist?.artistName || "Unknown Artist",
                    artistId: album.artist?.id,
                    artistMbid: album.artist?.foreignArtistId,
                    albumMbid: album.foreignAlbumId,
                    releaseDate: album.releaseDate,
                    monitored: album.monitored,
                    grabbed: album.grabbed || false,
                    hasFile: album.statistics?.percentOfTracks === 100,
                    coverUrl:
                        album.images?.find(
                            (img: any) => img.coverType === "cover"
                        )?.remoteUrl || null,
                })
            );

            logger.debug(
                `[LIDARR] Calendar: Found ${releases.length} releases between ${start} and ${end}`
            );
            return releases;
        } catch (error: any) {
            logger.error(`[LIDARR] Failed to fetch calendar:`, error.message);
            return [];
        }
    }

    /**
     * Get all monitored artists from Lidarr
     */
    async getMonitoredArtists(): Promise<
        { id: number; name: string; mbid: string }[]
    > {
        await this.ensureInitialized();

        if (!this.client) {
            return [];
        }

        try {
            const response = await this.client.get(`/api/v1/artist`);
            const artists = response.data as LidarrArtist[];
            return artists
                .filter((artist) => artist.monitored)
                .map((artist) => ({
                    id: artist.id,
                    name: artist.artistName,
                    mbid: artist.foreignArtistId,
                }));
        } catch (error: any) {
            logger.error(
                `[LIDARR] Failed to fetch monitored artists:`,
                error.message
            );
            return [];
        }
    }

    /**
     * Fetch all data needed for reconciliation in minimal API calls.
     * Returns indexed Maps for O(1) lookups against job data.
     *
     * This replaces multiple per-job API calls with a single snapshot fetch.
     */
    async getReconciliationSnapshot(): Promise<ReconciliationSnapshot> {
        await this.ensureInitialized();

        const snapshot: ReconciliationSnapshot = {
            queue: new Map(),
            albumsByMbid: new Map(),
            albumsByTitle: new Map(),
            fetchedAt: new Date(),
        };

        if (!this.enabled || !this.client) {
            return snapshot;
        }

        try {
            const fetchAlbumsForSnapshot = async (): Promise<LidarrAlbum[]> => {
                const albums: LidarrAlbum[] = [];

                const artistsResponse = await this.client!.get("/api/v1/artist");
                const artists = Array.isArray(artistsResponse.data)
                    ? (artistsResponse.data as LidarrArtist[])
                    : [];

                const artistBatchSize = 25;
                for (let start = 0; start < artists.length; start += artistBatchSize) {
                    const batch = artists.slice(start, start + artistBatchSize);
                    const batchResponses = await Promise.all(
                        batch.map((artist) =>
                            this.client!
                                .get("/api/v1/album", {
                                    params: { artistId: artist.id },
                                })
                                .catch((err: any) => {
                                    logger.warn(
                                        `[LIDARR] Failed to fetch albums for artist ${artist.id} during snapshot:`,
                                        err.message
                                    );
                                    return { data: [] };
                                })
                        )
                    );

                    for (const response of batchResponses) {
                        if (Array.isArray(response.data)) {
                            albums.push(...(response.data as LidarrAlbum[]));
                        }
                    }
                }

                logger.debug(
                    `[LIDARR] Snapshot album fetch: ${artists.length} artists, ${albums.length} albums fetched`
                );

                return albums;
            };

            // Fetch queue and albums in parallel
            const [queueResponse, albumsResponse] = await Promise.all([
                this.client.get("/api/v1/queue", {
                    params: { page: 1, pageSize: 1000, includeUnknownArtistItems: true },
                }).catch((err: any) => {
                    logger.error("[LIDARR] Failed to fetch queue for snapshot:", err.message);
                    return { data: { records: [] } };
                }),
                fetchAlbumsForSnapshot().catch((err: any) => {
                    logger.error("[LIDARR] Failed to fetch albums for snapshot:", err.message);
                    return [];
                }),
            ]);

            // Index queue items by downloadId
            const queueItems = queueResponse.data.records || [];
            for (const item of queueItems) {
                if (item.downloadId) {
                    snapshot.queue.set(item.downloadId, {
                        id: item.id,
                        downloadId: item.downloadId,
                        status: item.status,
                        progress: item.sizeleft && item.size
                            ? Math.round(((item.size - item.sizeleft) / item.size) * 100)
                            : undefined,
                        title: item.title,
                    });
                }
            }

            // Index albums by MBID and normalized title
            const albums = albumsResponse || [];
            for (const album of albums) {
                const hasFiles = album.statistics?.percentOfTracks > 0;
                if (!hasFiles) continue; // Only index albums with files

                const albumInfo: AlbumSnapshotInfo = {
                    id: album.id,
                    title: album.title,
                    foreignAlbumId: album.foreignAlbumId,
                    artistName: album.artist?.artistName || "",
                    hasFiles: true,
                };

                // Index by MBID
                if (album.foreignAlbumId) {
                    snapshot.albumsByMbid.set(album.foreignAlbumId, albumInfo);
                }

                // Index by normalized "artist|title" for title-based lookups
                if (albumInfo.artistName && album.title) {
                    const key = `${albumInfo.artistName.toLowerCase().trim()}|${album.title.toLowerCase().trim()}`;
                    snapshot.albumsByTitle.set(key, albumInfo);
                }
            }

            logger.debug(
                `[LIDARR] Snapshot fetched: ${snapshot.queue.size} queue items, ${snapshot.albumsByMbid.size} albums with files`
            );

            return snapshot;
        } catch (error: any) {
            logger.error("[LIDARR] Failed to create reconciliation snapshot:", error.message);
            return snapshot;
        }
    }

    /**
     * Check if an album is available using a pre-fetched snapshot.
     * Returns true if the album exists with files.
     */
    isAlbumAvailableInSnapshot(
        snapshot: ReconciliationSnapshot,
        mbid?: string,
        artistName?: string,
        albumTitle?: string
    ): boolean {
        // Strategy 1: Check by MBID
        if (mbid && snapshot.albumsByMbid.has(mbid)) {
            return true;
        }

        // Strategy 2: Check by normalized artist|title
        if (artistName && albumTitle) {
            const key = `${artistName.toLowerCase().trim()}|${albumTitle.toLowerCase().trim()}`;
            if (snapshot.albumsByTitle.has(key)) {
                return true;
            }

            // Strategy 3: Partial title match (handles edition differences)
            const normalizedArtist = artistName.toLowerCase().trim();
            const normalizedAlbum = albumTitle.toLowerCase().trim();
            for (const [titleKey, info] of snapshot.albumsByTitle) {
                const [keyArtist, keyAlbum] = titleKey.split("|");
                if (
                    keyArtist === normalizedArtist &&
                    (keyAlbum.includes(normalizedAlbum) || normalizedAlbum.includes(keyAlbum))
                ) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Check if a download is active using a pre-fetched snapshot.
     */
    isDownloadActiveInSnapshot(
        snapshot: ReconciliationSnapshot,
        downloadId: string
    ): { active: boolean; progress?: number } {
        const item = snapshot.queue.get(downloadId);
        if (!item) {
            return { active: false };
        }
        // Consider it active unless explicitly failed
        const isActive = item.status !== "failed" && item.status !== "warning";
        return { active: isActive, progress: item.progress };
    }
}

/**
 * Snapshot of Lidarr state for efficient batch reconciliation
 */
export interface ReconciliationSnapshot {
    queue: Map<string, QueueSnapshotItem>;
    albumsByMbid: Map<string, AlbumSnapshotInfo>;
    albumsByTitle: Map<string, AlbumSnapshotInfo>;
    fetchedAt: Date;
}

export interface QueueSnapshotItem {
    id: number;
    downloadId: string;
    status: string;
    progress?: number;
    title: string;
}

export interface AlbumSnapshotInfo {
    id: number;
    title: string;
    foreignAlbumId: string;
    artistName: string;
    hasFiles: boolean;
}

// Interface for calendar release data
export interface CalendarRelease {
    id: number;
    title: string;
    artistName: string;
    artistId?: number;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    monitored: boolean;
    grabbed: boolean;
    hasFile: boolean;
    coverUrl: string | null;
}

// Interface for indexer release data from Lidarr (exported for use by simpleDownloadManager)
export interface LidarrIndexerRelease {
    guid: string;
    title: string;
    indexerId: number;
    indexer?: string;
    size?: number;
    seeders?: number;
    leechers?: number;
    protocol: string; // usenet, torrent
    approved: boolean;
    rejected: boolean;
    rejections?: string[];
    quality?: {
        quality: { name: string };
    };
}

export const lidarrService = new LidarrService();

// Patterns that indicate a stuck download (case-insensitive matching)
const FAILED_IMPORT_PATTERNS = [
    // Import issues
    "No files found are eligible for import",
    "Not an upgrade for existing",
    "Not a Custom Format upgrade",
    "missing tracks",
    "Album match is not close enough", // Lidarr matching threshold failure
    "Artist name mismatch", // Manual import required - artist doesn't match
    "automatic import is not possible", // Generic auto-import failure
    // Unpack/extraction failures
    "Unable to extract",
    "Failed to extract",
    "Unpacking failed",
    "unpack error",
    "Error extracting",
    "extraction failed",
    "corrupt archive",
    "invalid archive",
    "CRC failed",
    "bad archive",
    // Download/transfer issues
    "Download failed",
    "import failed",
    "Sample",
];

/**
 * Clean stuck downloads from Lidarr queue
 * Returns items that were removed and will trigger automatic search for alternatives
 */
export async function cleanStuckDownloads(
    lidarrUrl: string,
    apiKey: string
): Promise<{ removed: number; items: string[] }> {
    const removed: string[] = [];

    try {
        // Fetch current queue
        const response = await axios.get<LidarrQueueResponse>(
            `${lidarrUrl}/api/v1/queue`,
            {
                params: {
                    page: 1,
                    pageSize: 100,
                    includeUnknownArtistItems: true,
                },
                headers: { "X-Api-Key": apiKey },
            }
        );

        logger.debug(
            ` Queue cleaner: checking ${response.data.records.length} items`
        );

        for (const item of response.data.records) {
            // Check if this item has a failed import message
            const allMessages =
                item.statusMessages?.flatMap((sm) => sm.messages) || [];

            // Log ALL items to understand what states we're seeing
            logger.debug(`   - ${item.title}`);
            logger.debug(
                `      Status: ${item.status}, TrackedStatus: ${item.trackedDownloadStatus}, State: ${item.trackedDownloadState}`
            );
            if (allMessages.length > 0) {
                logger.debug(`      Messages: ${allMessages.join("; ")}`);
            }

            // Check for pattern matches in messages
            const hasFailedPattern = allMessages.some((msg) =>
                FAILED_IMPORT_PATTERNS.some((pattern) =>
                    msg.toLowerCase().includes(pattern.toLowerCase())
                )
            );

            // Also check if trackedDownloadStatus is "warning" with importPending state
            // These are items that have finished downloading but can't be imported
            const isStuckWarning =
                item.trackedDownloadStatus === "warning" &&
                item.trackedDownloadState === "importPending";

            // CRITICAL: importFailed state is TERMINAL - will never recover
            // Don't wait for timeout, clean up immediately
            const isImportFailed = item.trackedDownloadState === "importFailed";

            const shouldRemove =
                hasFailedPattern || isStuckWarning || isImportFailed;

            if (shouldRemove) {
                const reason = isImportFailed
                    ? "importFailed state (terminal)"
                    : hasFailedPattern
                    ? "failed pattern match"
                    : "stuck warning state";
                logger.debug(`   [REMOVE] Removing ${item.title} (${reason})`);

                try {
                    // Remove from queue, blocklist the release, trigger new search
                    await axios.delete(`${lidarrUrl}/api/v1/queue/${item.id}`, {
                        params: {
                            removeFromClient: true, // Remove from NZBGet too
                            blocklist: true, // Don't try this release again
                            skipRedownload: false, // DO trigger new search
                        },
                        headers: { "X-Api-Key": apiKey },
                    });

                    removed.push(item.title);
                    logger.debug(`   Removed and blocklisted: ${item.title}`);
                } catch (deleteError: any) {
                    // Item might already be gone - that's fine
                    if (deleteError.response?.status !== 404) {
                        logger.error(
                            `    Failed to remove ${item.title}:`,
                            deleteError.message
                        );
                    }
                }
            }
        }

        if (removed.length > 0) {
            logger.debug(
                ` Queue cleaner: removed ${removed.length} stuck item(s)`
            );
        }

        return { removed: removed.length, items: removed };
    } catch (error: any) {
        logger.error("Queue clean failed:", error.message);
        throw error;
    }
}

/**
 * Get recently completed downloads from Lidarr history
 * Used to find orphaned completions (webhooks that never arrived)
 */
export async function getRecentCompletedDownloads(
    lidarrUrl: string,
    apiKey: string,
    sinceMinutes: number = 5
): Promise<LidarrHistoryRecord[]> {
    try {
        const response = await axios.get<LidarrHistoryResponse>(
            `${lidarrUrl}/api/v1/history`,
            {
                params: {
                    page: 1,
                    pageSize: 100,
                    sortKey: "date",
                    sortDirection: "descending",
                    eventType: 3, // 3 = downloadFolderImported (successful import)
                },
                headers: { "X-Api-Key": apiKey },
            }
        );

        // Filter to only recent imports (within last X minutes)
        const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000);
        return response.data.records.filter((record) => {
            return new Date(record.date) >= cutoff;
        });
    } catch (error: any) {
        logger.error("Failed to fetch Lidarr history:", error.message);
        throw error;
    }
}

