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
import { downloadAndStoreImage, isNativePath } from "./imageStorage";
import { trackIdentityService } from "./trackIdentity";

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
                    const artistMbidForSimilar = enrichmentData.mbid || artist.mbid;
                    const similar = await lastFmService.getSimilarArtists(
                        artistMbidForSimilar && !artistMbidForSimilar.startsWith("temp-")
                            ? artistMbidForSimilar
                            : "",
                        artist.name,
                        10
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

        if (data.mbid) {
            updateData.mbid = data.mbid;
        }

        if (data.bio) updateData.summary = data.bio;
        if (data.heroUrl) {
            if (!isNativePath(data.heroUrl)) {
                const current = await prisma.artist.findUnique({
                    where: { id: artistId },
                    select: { heroUrl: true },
                });
                if (current?.heroUrl && isNativePath(current.heroUrl)) {
                    // Keep existing local image, skip external URL
                } else {
                    const localPath = await downloadAndStoreImage(
                        data.heroUrl,
                        artistId,
                        "artist"
                    );
                    updateData.heroUrl = localPath || data.heroUrl;
                }
            } else {
                updateData.heroUrl = data.heroUrl;
            }
        }
        if (data.genres && data.genres.length > 0) {
            updateData.genres = data.genres;
        }

        if (Object.keys(updateData).length > 0) {
            try {
                await prisma.artist.update({
                    where: { id: artistId },
                    data: updateData,
                });
                logger.debug(
                    `   Saved ${data.genres?.length || 0} genres for artist`
                );
            } catch (error: any) {
                if (error.code === "P2002" && updateData.mbid) {
                    logger.debug(
                        `MBID ${updateData.mbid} already used by another artist, retrying without mbid`
                    );
                    delete updateData.mbid;
                    if (Object.keys(updateData).length > 0) {
                        await prisma.artist.update({
                            where: { id: artistId },
                            data: updateData,
                        });
                    }
                } else {
                    throw error;
                }
            }
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
        if (data.coverUrl) {
            // Download cover locally if it's an external URL
            if (!isNativePath(data.coverUrl)) {
                const localPath = await downloadAndStoreImage(
                    data.coverUrl,
                    albumId,
                    "album"
                );
                updateData.coverUrl = localPath || data.coverUrl;
            } else {
                updateData.coverUrl = data.coverUrl;
            }
        }
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
     * Enrich tracks that have no ISRC by searching MusicBrainz recordings.
     * Runs as part of the enrichment cycle, after artist enrichment.
     */
    async enrichTrackIdentity(limit = 100): Promise<number> {
        const tracks = await prisma.track.findMany({
            where: {
                isrc: null,
                corrupt: false,
                album: { location: "LIBRARY" },
            },
            include: {
                album: { include: { artist: { select: { name: true } } } },
            },
            take: limit,
        });

        let enriched = 0;
        for (const track of tracks) {
            try {
                const recording = await musicBrainzService.searchRecording(
                    track.title,
                    track.album.artist.name,
                );
                if (!recording) continue;

                // Look up ISRC from recording
                const isrcData = await musicBrainzService.getRecordingIsrc(recording.trackMbid);
                if (isrcData) {
                    await trackIdentityService.storeIsrc(track.id, isrcData, "musicbrainz");
                }

                // Fetch and store genres
                const genreData = await musicBrainzService.getRecordingGenres(recording.trackMbid);
                if (genreData && genreData.genres.length > 0) {
                    const topGenres = genreData.genres
                        .sort((a, b) => b.count - a.count)
                        .slice(0, 5)
                        .map((g) => g.name);
                    await trackIdentityService.populateTrackGenres(track.id, topGenres);
                }

                enriched++;
            } catch {
                // Non-fatal, continue
            }
        }

        return enriched;
    }
}

export const enrichmentService = new EnrichmentService();
