/**
 * Metadata Enrichment Service
 *
 * Enriches artist/album/track metadata using multiple sources:
 * - MusicBrainz: MBIDs, release dates, track info
 * - Last.fm: Genres, tags, similar artists, bio
 * - Cover Art Archive: Album artwork
 * - Discogs: Additional metadata (optional)
 *
 * Features:
 * - Optional/opt-in (bandwidth intensive)
 * - Rate limiting to respect API limits
 * - Confidence scoring for matches
 * - Manual override support
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { lastFmService } from "./lastfm";
import { musicBrainzService } from "./musicbrainz";
import { imageProviderService } from "./imageProvider";

export interface EnrichmentSettings {
    enabled: boolean;
    autoEnrichOnScan: boolean;
    sources: {
        musicbrainz: boolean;
        lastfm: boolean;
        coverArtArchive: boolean;
    };
    rateLimit: {
        maxRequestsPerMinute: number;
        respectApiLimits: boolean;
    };
    overwriteExisting: boolean;
    matchingConfidence: "strict" | "moderate" | "loose";
}

export interface EnrichmentResult {
    success: boolean;
    itemsProcessed: number;
    itemsEnriched: number;
    itemsFailed: number;
    errors: Array<{ item: string; error: string }>;
}

export interface ArtistEnrichmentData {
    mbid?: string;
    bio?: string;
    genres?: string[];
    tags?: string[];
    similarArtists?: string[];
    heroUrl?: string;
    formed?: number;
    confidence: number;
}

export interface AlbumEnrichmentData {
    rgMbid?: string;
    releaseDate?: Date;
    albumType?: string;
    genres?: string[];
    tags?: string[];
    label?: string;
    coverUrl?: string;
    trackCount?: number;
    confidence: number;
}

export interface TrackEnrichmentData {
    mbid?: string;
    duration?: number;
    genres?: string[];
    lyrics?: string;
    confidence: number;
}

export class EnrichmentService {
    private defaultSettings: EnrichmentSettings = {
        enabled: false, // Opt-in by default
        autoEnrichOnScan: false,
        sources: {
            musicbrainz: true,
            lastfm: true,
            coverArtArchive: true,
        },
        rateLimit: {
            maxRequestsPerMinute: 30,
            respectApiLimits: true,
        },
        overwriteExisting: false,
        matchingConfidence: "moderate",
    };

    private requestQueue: Array<() => Promise<any>> = [];
    private isProcessingQueue = false;

    /**
     * Get enrichment settings for a user
     */
    async getSettings(userId: string): Promise<EnrichmentSettings> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { enrichmentSettings: true },
        });

        if (user?.enrichmentSettings) {
            // enrichmentSettings is already a JSON object from Prisma
            let userSettings: any;
            if (typeof user.enrichmentSettings === "string") {
                userSettings = JSON.parse(user.enrichmentSettings);
            } else {
                userSettings = user.enrichmentSettings;
            }

            // IMPORTANT: Always merge with defaults to ensure all fields exist
            return {
                ...this.defaultSettings,
                ...userSettings,
                sources: {
                    ...this.defaultSettings.sources,
                    ...(userSettings.sources || {}),
                },
                rateLimit: {
                    ...this.defaultSettings.rateLimit,
                    ...(userSettings.rateLimit || {}),
                },
            };
        }

        return this.defaultSettings;
    }

    /**
     * Update enrichment settings for a user
     */
    async updateSettings(
        userId: string,
        settings: Partial<EnrichmentSettings>
    ): Promise<EnrichmentSettings> {
        const current = await this.getSettings(userId);
        const updated = { ...current, ...settings };

        await prisma.user.update({
            where: { id: userId },
            data: {
                enrichmentSettings: JSON.stringify(updated) as any,
            },
        });

        return updated;
    }

    /**
     * Enrich a single artist with metadata from multiple sources
     */
    async enrichArtist(
        artistId: string,
        settings?: EnrichmentSettings
    ): Promise<ArtistEnrichmentData | null> {
        const config = settings || this.defaultSettings;
        if (!config.enabled) {
            return null;
        }

        const artist = await prisma.artist.findUnique({
            where: { id: artistId },
            select: { id: true, name: true, mbid: true },
        });

        if (!artist) {
            throw new Error(`Artist ${artistId} not found`);
        }

        logger.debug(`Enriching artist: ${artist.name}`);

        const enrichmentData: ArtistEnrichmentData = {
            confidence: 0,
        };

        // Step 1: Get/verify MBID from MusicBrainz
        if (
            config.sources.musicbrainz &&
            (!artist.mbid || artist.mbid.startsWith("temp-"))
        ) {
            try {
                const mbResults = await musicBrainzService.searchArtist(
                    artist.name,
                    1
                );
                if (mbResults.length > 0) {
                    enrichmentData.mbid = mbResults[0].id;
                    enrichmentData.confidence += 0.4;
                    logger.debug(`  Found MBID: ${enrichmentData.mbid}`);
                }
            } catch (error) {
                logger.error(` MusicBrainz lookup failed:`, error);
            }
        }

        // Step 2: Get artist info from Last.fm
        if (config.sources.lastfm) {
            try {
                const artistMbid = enrichmentData.mbid || artist.mbid;
                const lastfmInfo = await lastFmService.getArtistInfo(
                    artist.name,
                    artistMbid && !artistMbid.startsWith("temp-")
                        ? artistMbid
                        : undefined
                );

                if (lastfmInfo) {
                    enrichmentData.bio = lastfmInfo.bio?.summary;
                    enrichmentData.tags =
                        lastfmInfo.tags?.tag?.map((t: any) => t.name) || [];
                    enrichmentData.genres = enrichmentData.tags?.slice(0, 3); // Top 3 tags as genres
                    enrichmentData.confidence += 0.3;
                    logger.debug(
                        `  Found Last.fm data: ${
                            enrichmentData.tags?.length || 0
                        } tags`
                    );

                    // Get similar artists
                    const similar = await lastFmService.getSimilarArtists(
                        artist.name,
                        "10"
                    );
                    enrichmentData.similarArtists = similar.map(
                        (a: any) => a.name
                    );
                    logger.debug(`  Found ${similar.length} similar artists`);
                }
            } catch (error) {
                logger.error(
                    `  ✗ Last.fm lookup failed:`,
                    error instanceof Error ? error.message : error
                );
            }
        }

        // Step 3: Get artist image from multiple sources (Deezer → Fanart → MusicBrainz → Last.fm)
        try {
            const artistMbid = enrichmentData.mbid || artist.mbid;
            const imageResult = await imageProviderService.getArtistImage(
                artist.name,
                artistMbid && !artistMbid.startsWith("temp-")
                    ? artistMbid
                    : undefined
            );

            if (imageResult) {
                enrichmentData.heroUrl = imageResult.url;
                enrichmentData.confidence += 0.2;
                logger.debug(`  Found artist image from ${imageResult.source}`);
            }
        } catch (error) {
            logger.error(
                `  ✗ Artist image lookup failed:`,
                error instanceof Error ? error.message : error
            );
        }

        logger.debug(
            `  Enrichment confidence: ${(
                enrichmentData.confidence * 100
            ).toFixed(0)}%`
        );

        return enrichmentData;
    }

    /**
     * Enrich a single album with metadata from multiple sources
     */
    async enrichAlbum(
        albumId: string,
        settings?: EnrichmentSettings
    ): Promise<AlbumEnrichmentData | null> {
        const config = settings || this.defaultSettings;
        if (!config.enabled) {
            return null;
        }

        const album = await prisma.album.findUnique({
            where: { id: albumId },
            include: {
                artist: {
                    select: { name: true, mbid: true },
                },
            },
        });

        if (!album) {
            throw new Error(`Album ${albumId} not found`);
        }

        logger.debug(
            `[Enrichment] Processing album: ${album.artist.name} - ${album.title}`
        );

        const enrichmentData: AlbumEnrichmentData = {
            confidence: 0,
        };

        // Step 1: Try to find MBID
        if (config.sources.musicbrainz) {
            try {
                // If artist has MBID, search their discography
                if (
                    album.artist.mbid &&
                    !album.artist.mbid.startsWith("temp-")
                ) {
                    const releaseGroups =
                        await musicBrainzService.getReleaseGroups(
                            album.artist.mbid,
                            ["album", "ep"],
                            50
                        );

                    // Try to match by title
                    const match = releaseGroups.find(
                        (rg: any) =>
                            rg.title.toLowerCase() ===
                                album.title.toLowerCase() ||
                            rg.title.toLowerCase().replace(/[^a-z0-9]/g, "") ===
                                album.title
                                    .toLowerCase()
                                    .replace(/[^a-z0-9]/g, "")
                    );

                    if (match) {
                        enrichmentData.rgMbid = match.id;
                        enrichmentData.albumType = match["primary-type"];
                        enrichmentData.releaseDate = match["first-release-date"]
                            ? new Date(match["first-release-date"])
                            : undefined;
                        enrichmentData.confidence += 0.5;
                        logger.debug(`  Found MBID: ${enrichmentData.rgMbid}`);

                        // Try to get label info from first release
                        try {
                            const rgDetails =
                                await musicBrainzService.getReleaseGroup(
                                    match.id
                                );
                            if (rgDetails?.releases?.[0]?.id) {
                                const releaseId = rgDetails.releases[0].id;
                                const releaseInfo =
                                    await musicBrainzService.getRelease(
                                        releaseId
                                    );
                                if (
                                    releaseInfo?.["label-info"]?.[0]?.label
                                        ?.name
                                ) {
                                    enrichmentData.label =
                                        releaseInfo["label-info"][0].label.name;
                                    logger.debug(
                                        `  Found label: ${enrichmentData.label}`
                                    );
                                }
                            }
                        } catch (error) {
                            logger.debug(`Could not fetch label info`);
                        }
                    }
                }
            } catch (error) {
                logger.error(` MusicBrainz lookup failed:`, error);
            }
        }

        // Step 2: Get album info from Last.fm
        if (config.sources.lastfm) {
            try {
                const lastfmInfo = await lastFmService.getAlbumInfo(
                    album.artist.name,
                    album.title
                );

                if (lastfmInfo) {
                    enrichmentData.tags =
                        lastfmInfo.tags?.tag?.map((t: any) => t.name) || [];
                    enrichmentData.genres = enrichmentData.tags?.slice(0, 3);
                    enrichmentData.trackCount =
                        lastfmInfo.tracks?.track?.length;
                    enrichmentData.confidence += 0.3;
                    logger.debug(
                        `  Found Last.fm data: ${
                            enrichmentData.tags?.length || 0
                        } tags`
                    );
                }
            } catch (error) {
                logger.error(` Last.fm lookup failed:`, error);
            }
        }

        // Step 3: Get cover art from multiple sources (Deezer → MusicBrainz → Fanart)
        try {
            const coverResult = await imageProviderService.getAlbumCover(
                album.artist.name,
                album.title,
                enrichmentData.rgMbid
            );

            if (coverResult) {
                enrichmentData.coverUrl = coverResult.url;
                enrichmentData.confidence += 0.2;
                logger.debug(`  Found cover art from ${coverResult.source}`);
            }
        } catch (error) {
            logger.error(
                `  ✗ Cover art lookup failed:`,
                error instanceof Error ? error.message : error
            );
        }

        logger.debug(
            `  Enrichment confidence: ${(
                enrichmentData.confidence * 100
            ).toFixed(0)}%`
        );

        return enrichmentData;
    }

    /**
     * Apply enrichment data to an artist in the database
     */
    async applyArtistEnrichment(
        artistId: string,
        data: ArtistEnrichmentData
    ): Promise<void> {
        const updateData: any = {};

        // Check if MBID is already in use by another artist
        if (data.mbid) {
            const existingArtist = await prisma.artist.findUnique({
                where: { mbid: data.mbid },
                select: { id: true, name: true },
            });

            if (existingArtist && existingArtist.id !== artistId) {
                logger.debug(
                    `MBID ${data.mbid} already used by "${existingArtist.name}", skipping MBID update`
                );
            } else {
                updateData.mbid = data.mbid;
            }
        }

        if (data.bio) updateData.summary = data.bio;
        if (data.heroUrl) updateData.heroUrl = data.heroUrl;
        if (data.genres && data.genres.length > 0) {
            updateData.genres = data.genres;
        }

        if (Object.keys(updateData).length > 0) {
            await prisma.artist.update({
                where: { id: artistId },
                data: updateData,
            });
            logger.debug(
                `   Saved ${data.genres?.length || 0} genres for artist`
            );
        }
    }

    /**
     * Apply enrichment data to an album in the database
     */
    async applyAlbumEnrichment(
        albumId: string,
        data: AlbumEnrichmentData
    ): Promise<void> {
        const updateData: any = {};

        if (data.rgMbid) updateData.rgMbid = data.rgMbid;
        if (data.coverUrl) updateData.coverUrl = data.coverUrl;
        if (data.releaseDate) {
            // Store original release date in dedicated field
            updateData.originalYear = data.releaseDate.getFullYear();
            // Also update year for backward compatibility (but originalYear takes precedence)
            updateData.year = data.releaseDate.getFullYear();
        }
        if (data.label) updateData.label = data.label;
        if (data.genres && data.genres.length > 0) {
            updateData.genres = data.genres;
        }

        if (Object.keys(updateData).length > 0) {
            await prisma.album.update({
                where: { id: albumId },
                data: updateData,
            });
            logger.debug(
                `   Saved album data: ${
                    data.genres?.length || 0
                } genres, label: ${data.label || "none"}`
            );
        }

        // Update OwnedAlbum table if MBID changed
        if (data.rgMbid) {
            const album = await prisma.album.findUnique({
                where: { id: albumId },
                select: { artistId: true },
            });

            if (album) {
                await prisma.ownedAlbum.upsert({
                    where: {
                        artistId_rgMbid: {
                            artistId: album.artistId,
                            rgMbid: data.rgMbid,
                        },
                    },
                    create: {
                        artistId: album.artistId,
                        rgMbid: data.rgMbid,
                        source: "enrichment",
                    },
                    update: {},
                });
            }
        }
    }

    /**
     * Enrich entire library for a user
     */
    async enrichLibrary(
        userId: string,
        onProgress?: (progress: {
            current: number;
            total: number;
            item: string;
        }) => void
    ): Promise<EnrichmentResult> {
        const settings = await this.getSettings(userId);
        if (!settings.enabled) {
            throw new Error("Enrichment is not enabled for this user");
        }

        const result: EnrichmentResult = {
            success: true,
            itemsProcessed: 0,
            itemsEnriched: 0,
            itemsFailed: 0,
            errors: [],
        };

        // Get all artists with their albums
        const artists = await prisma.artist.findMany({
            where: {
                albums: {
                    some: {}, // Only artists with albums
                },
            },
            select: {
                id: true,
                name: true,
                albums: {
                    select: { id: true, title: true },
                },
            },
        });

        logger.debug(`Starting enrichment for ${artists.length} artists...`);

        for (const artist of artists) {
            try {
                result.itemsProcessed++;
                onProgress?.({
                    current: result.itemsProcessed,
                    total:
                        artists.length +
                        artists.reduce((sum, a) => sum + a.albums.length, 0),
                    item: `${artist.name}`,
                });

                // Enrich artist
                const artistEnrichmentData = await this.enrichArtist(
                    artist.id,
                    settings
                );
                if (
                    artistEnrichmentData &&
                    artistEnrichmentData.confidence > 0.3
                ) {
                    await this.applyArtistEnrichment(
                        artist.id,
                        artistEnrichmentData
                    );
                    result.itemsEnriched++;
                }

                // Enrich all albums for this artist
                for (const album of artist.albums) {
                    try {
                        result.itemsProcessed++;
                        onProgress?.({
                            current: result.itemsProcessed,
                            total:
                                artists.length +
                                artists.reduce(
                                    (sum, a) => sum + a.albums.length,
                                    0
                                ),
                            item: `${artist.name} - ${album.title}`,
                        });

                        const albumEnrichmentData = await this.enrichAlbum(
                            album.id,
                            settings
                        );
                        if (
                            albumEnrichmentData &&
                            albumEnrichmentData.confidence > 0.3
                        ) {
                            await this.applyAlbumEnrichment(
                                album.id,
                                albumEnrichmentData
                            );
                            result.itemsEnriched++;
                        }

                        // Rate limiting between albums
                        await new Promise((resolve) =>
                            setTimeout(resolve, 500)
                        );
                    } catch (error: any) {
                        result.itemsFailed++;
                        result.errors.push({
                            item: `${artist.name} - ${album.title}`,
                            error: error.message,
                        });
                        logger.error(
                            `  ✗ Failed to enrich ${artist.name} - ${album.title}:`,
                            error
                        );
                    }
                }

                // Rate limiting between artists
                await new Promise((resolve) => setTimeout(resolve, 1000));
            } catch (error: any) {
                result.itemsFailed++;
                result.errors.push({
                    item: artist.name,
                    error: error.message,
                });
                logger.error(` Failed to enrich ${artist.name}:`, error);
            }
        }

        logger.debug(
            `Enrichment complete: ${result.itemsEnriched}/${result.itemsProcessed} items enriched`
        );

        return result;
    }
}

export const enrichmentService = new EnrichmentService();
