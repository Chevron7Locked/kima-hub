import { Artist } from "@prisma/client";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { wikidataService } from "../services/wikidata";
import { lastFmService } from "../services/lastfm";
import { fanartService } from "../services/fanart";
import { deezerService } from "../services/deezer";
import { musicBrainzService } from "../services/musicbrainz";
import { normalizeArtistName } from "../utils/artistNormalization";
import { coverArtService } from "../services/coverArt";
import { redisClient } from "../utils/redis";
import { downloadAndStoreImage, isNativePath, nativeFileExists } from "../services/imageStorage";

/**
 * Enriches an artist with metadata from Wikidata and Last.fm
 * - Fetches artist bio/summary and hero image from Wikidata
 * - Falls back to Last.fm if Wikidata fails
 * - Fetches similar artists from Last.fm
 */
export async function enrichSimilarArtist(artist: Artist): Promise<void> {
    const logPrefix = `[ENRICH ${artist.name}]`;
    logger.debug(`${logPrefix} Starting enrichment (MBID: ${artist.mbid})`);

    // Mark as enriching
    await prisma.artist.update({
        where: { id: artist.id },
        data: { enrichmentStatus: "enriching" },
    });

    // Track which source provided data
    let imageSource = "none";
    let summarySource = "none";

    try {
        // If artist has a temp MBID, try to get the real one from MusicBrainz
        if (artist.mbid.startsWith("temp-")) {
            logger.debug(
                `${logPrefix} Temp MBID detected, searching MusicBrainz...`
            );
            try {
                const mbResults = await musicBrainzService.searchArtist(
                    artist.name,
                    1
                );
                if (mbResults.length > 0 && mbResults[0].id) {
                    const realMbid = mbResults[0].id;
                    logger.debug(
                        `${logPrefix} MusicBrainz: Found real MBID: ${realMbid}`
                    );

                    // Update artist with real MBID
                    try {
                        await prisma.artist.update({
                            where: { id: artist.id },
                            data: { mbid: realMbid },
                        });
                        artist.mbid = realMbid;
                    } catch (mbidError: any) {
                        if (mbidError.code === "P2002") {
                            logger.debug(
                                `${logPrefix} MBID ${realMbid} already used by another artist, keeping temp`
                            );
                        } else {
                            throw mbidError;
                        }
                    }
                } else {
                    logger.debug(
                        `${logPrefix} MusicBrainz: No match found, marking as unresolvable`
                    );
                    await prisma.artist.update({
                        where: { id: artist.id },
                        data: { enrichmentStatus: "unresolvable", lastEnriched: new Date() },
                    });
                    return;
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} MusicBrainz: FAILED - ${
                        error?.message || error
                    }`
                );
            }
        }

        // Try Wikidata first (only if we have a real MBID)
        // Preserve existing heroUrl (e.g., from local file found during scan)
        let summary = null;
        // Only preserve existing heroUrl if the file actually exists on disk
        let heroUrl = (artist.heroUrl && (!isNativePath(artist.heroUrl) || nativeFileExists(artist.heroUrl)))
            ? artist.heroUrl
            : null;
        let genres: string[] = [];

        if (!artist.mbid.startsWith("temp-")) {
            logger.debug(
                `${logPrefix} Wikidata: Fetching for MBID ${artist.mbid}...`
            );
            try {
                const wikidataInfo = await wikidataService.getArtistInfo(
                    artist.name,
                    artist.mbid
                );
                if (wikidataInfo) {
                    summary = wikidataInfo.summary;
                    if (!heroUrl && wikidataInfo.heroUrl) {
                        heroUrl = wikidataInfo.heroUrl;
                        imageSource = "wikidata";
                    }
                    if (summary) summarySource = "wikidata";
                    logger.debug(
                        `${logPrefix} Wikidata: SUCCESS (image: ${
                            heroUrl ? "yes" : "no"
                        }, summary: ${summary ? "yes" : "no"})`
                    );
                } else {
                    logger.debug(`${logPrefix} Wikidata: No data returned`);
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} Wikidata: FAILED - ${error?.message || error}`
                );
            }
        } else {
            logger.debug(`${logPrefix} Wikidata: Skipped (temp MBID)`);
        }

        // Fetch from Last.fm if we need summary/heroUrl or always try for genres
        if (!summary || !heroUrl || genres.length === 0) {
            logger.debug(
                `${logPrefix} Last.fm: Fetching (need summary: ${!summary}, need image: ${!heroUrl})...`
            );
            try {
                const validMbid = artist.mbid.startsWith("temp-")
                    ? undefined
                    : artist.mbid;
                const lastfmInfo = await lastFmService.getArtistInfo(
                    artist.name,
                    validMbid
                );
                if (lastfmInfo) {
                    // Extract text from bio object (bio.summary or bio.content)
                    if (!summary && lastfmInfo.bio) {
                        const bio = lastfmInfo.bio as any;
                        summary = bio.summary || bio.content || null;
                        if (summary) {
                            summarySource = "lastfm";
                            logger.debug(`${logPrefix} Last.fm: Got summary`);
                        }
                    }

                    // Extract genres from Last.fm tags
                    if (lastfmInfo.tags?.tag && Array.isArray(lastfmInfo.tags.tag)) {
                        genres = lastfmInfo.tags.tag
                            .slice(0, 5)  // Top 5 tags as genres
                            .map((t: any) => t.name)
                            .filter(Boolean);
                        if (genres.length > 0) {
                            logger.debug(`${logPrefix} Extracted ${genres.length} genres: ${genres.join(', ')}`);
                        }
                    }

                } else {
                    logger.debug(`${logPrefix} Last.fm: No data returned`);
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} Last.fm: FAILED - ${error?.message || error}`
                );
            }
        }

        // Image fallbacks run independently of Last.fm success
        // Try Fanart.tv (only with real MBID)
        if (!heroUrl && !artist.mbid.startsWith("temp-")) {
            logger.debug(
                `${logPrefix} Fanart.tv: Fetching for MBID ${artist.mbid}...`
            );
            try {
                heroUrl = await fanartService.getArtistImage(artist.mbid);
                if (heroUrl) {
                    imageSource = "fanart.tv";
                    logger.debug(
                        `${logPrefix} Fanart.tv: SUCCESS - ${heroUrl.substring(0, 60)}...`
                    );
                } else {
                    logger.debug(`${logPrefix} Fanart.tv: No image found`);
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} Fanart.tv: FAILED - ${error?.message || error}`
                );
            }
        }

        // Fallback to Deezer
        if (!heroUrl) {
            logger.debug(
                `${logPrefix} Deezer: Fetching for "${artist.name}"...`
            );
            try {
                heroUrl = await deezerService.getArtistImage(artist.name);
                if (heroUrl) {
                    imageSource = "deezer";
                    logger.debug(
                        `${logPrefix} Deezer: SUCCESS - ${heroUrl.substring(0, 60)}...`
                    );
                } else {
                    logger.debug(`${logPrefix} Deezer: No image found`);
                }
            } catch (error: any) {
                logger.debug(
                    `${logPrefix} Deezer: FAILED - ${error?.message || error}`
                );
            }
        }

        // Genre fallback: MusicBrainz curated genres (if Last.fm didn't return any)
        if (genres.length === 0 && !artist.mbid.startsWith("temp-")) {
            try {
                const mbArtist = await musicBrainzService.getArtist(artist.mbid, ["genres"]);
                if (mbArtist?.genres && Array.isArray(mbArtist.genres)) {
                    genres = mbArtist.genres
                        .sort((a: any, b: any) => (b.count || 0) - (a.count || 0))
                        .slice(0, 5)
                        .map((g: any) => g.name)
                        .filter(Boolean);
                    if (genres.length > 0) {
                        logger.debug(`${logPrefix} MusicBrainz: ${genres.length} genres: ${genres.join(', ')}`);
                    }
                }
            } catch (error: any) {
                logger.debug(`${logPrefix} MusicBrainz genres: FAILED - ${error?.message || error}`);
            }
        }

        // Get similar artists from Last.fm
        let similarArtists: Array<{
            name: string;
            mbid?: string;
            match: number;
        }> = [];
        try {
            // Filter out temp MBIDs
            const validMbid = artist.mbid.startsWith("temp-")
                ? ""
                : artist.mbid;
            similarArtists = await lastFmService.getSimilarArtists(
                validMbid,
                artist.name
            );
            logger.debug(
                `${logPrefix} Similar artists: Found ${similarArtists.length}`
            );
        } catch (error: any) {
            logger.debug(
                `${logPrefix} Similar artists: FAILED - ${
                    error?.message || error
                }`
            );
        }

        // Log enrichment summary
        logger.debug(
            `${logPrefix} SUMMARY: image=${imageSource}, summary=${summarySource}, heroUrl=${
                heroUrl ? "set" : "null"
            }`
        );

        // Download image locally if we have an external URL
        let localHeroUrl: string | null = null;
        if (heroUrl && !isNativePath(heroUrl)) {
            logger.debug(`${logPrefix} Downloading image locally...`);
            localHeroUrl = await downloadAndStoreImage(heroUrl, artist.id, "artist");
            if (localHeroUrl) {
                logger.debug(`${logPrefix} Image saved locally: ${localHeroUrl}`);
            } else {
                // Download failed -- fall back to external URL; re-read below will prefer any native path
                localHeroUrl = heroUrl;
                logger.debug(`${logPrefix} Failed to download image, using: ${localHeroUrl}`);
            }
        } else if (heroUrl) {
            localHeroUrl = heroUrl; // Already a native path
        }

        // Prepare similar artists JSON for storage (full Last.fm data)
        const similarArtistsJson: any =
            similarArtists.length > 0
                ? similarArtists.map((s) => ({
                      name: s.name,
                      mbid: s.mbid || null,
                      match: s.match,
                  }))
                : null;

        // Re-read current heroUrl to avoid clobbering scanner-written local images
        // But only if the file actually exists on disk
        const currentArtist = await prisma.artist.findUnique({
            where: { id: artist.id },
            select: { heroUrl: true },
        });
        const finalHeroUrl = (currentArtist?.heroUrl && isNativePath(currentArtist.heroUrl) && nativeFileExists(currentArtist.heroUrl))
            ? currentArtist.heroUrl
            : localHeroUrl;

        await prisma.artist.update({
            where: { id: artist.id },
            data: {
                summary,
                heroUrl: finalHeroUrl,
                similarArtistsJson,
                genres: genres.length > 0 ? genres : undefined,
                lastEnriched: new Date(),
                enrichmentStatus: "completed",
            },
        });

        // Store similar artists
        if (similarArtists.length > 0) {
            // Delete existing similar artist relationships
            await prisma.similarArtist.deleteMany({
                where: { fromArtistId: artist.id },
            });

            // Create new relationships
            for (const similar of similarArtists) {
                // Find existing similar artist (don't create new ones)
                let similarArtistRecord = null;

                if (similar.mbid) {
                    // Try to find by MBID first
                    similarArtistRecord = await prisma.artist.findUnique({
                        where: { mbid: similar.mbid },
                    });
                }

                if (!similarArtistRecord) {
                    // Try to find by normalized name (case-insensitive)
                    const normalizedSimilarName = normalizeArtistName(
                        similar.name
                    );
                    similarArtistRecord = await prisma.artist.findFirst({
                        where: { normalizedName: normalizedSimilarName },
                    });
                }

                // Only create similarity relationship if the similar artist already exists in our database
                // This prevents endless crawling of similar artists
                if (similarArtistRecord) {
                    await prisma.similarArtist.upsert({
                        where: {
                            fromArtistId_toArtistId: {
                                fromArtistId: artist.id,
                                toArtistId: similarArtistRecord.id,
                            },
                        },
                        create: {
                            fromArtistId: artist.id,
                            toArtistId: similarArtistRecord.id,
                            weight: similar.match,
                        },
                        update: {
                            weight: similar.match,
                        },
                    });
                }
            }

            logger.debug(
                `${logPrefix} Stored ${similarArtists.length} similar artist relationships`
            );
        }

        // Fetch covers for all albums belonging to this artist that don't have covers yet
        await enrichAlbumCovers(artist.id);

        // Cache artist image path in Redis for faster access
        if (localHeroUrl) {
            try {
                await redisClient.setex(
                    `hero:${artist.id}`,
                    7 * 24 * 60 * 60,
                    localHeroUrl
                );
            } catch (err) {
                // Redis errors are non-critical
            }
        }
    } catch (error: any) {
        logger.error(
            `${logPrefix} ENRICHMENT FAILED:`,
            error?.message || error
        );

        // Mark as failed
        await prisma.artist.update({
            where: { id: artist.id },
            data: { enrichmentStatus: "failed" },
        });

        throw error;
    }
}

/**
 * Enrich album covers for an artist
 * Fetches covers from Cover Art Archive for albums without covers
 */
async function enrichAlbumCovers(
    artistId: string,
): Promise<void> {
    try {
        // Find albums for this artist that don't have cover art
        // Find albums with no cover, or with a native cover file missing from disk
        const allAlbums = await prisma.album.findMany({
            where: {
                artistId,
            },
            select: {
                id: true,
                rgMbid: true,
                title: true,
                coverUrl: true,
            },
        });
        const albumsWithoutCovers = allAlbums.filter(
            (a) => !a.coverUrl || a.coverUrl === "" || (isNativePath(a.coverUrl) && !nativeFileExists(a.coverUrl))
        );

        if (albumsWithoutCovers.length === 0) {
            logger.debug(`    All albums already have covers`);
            return;
        }

        logger.debug(
            `    Fetching covers for ${albumsWithoutCovers.length} albums...`
        );

        let fetchedCount = 0;
        const BATCH_SIZE = 3; // Limit concurrent requests

        // Process in batches to avoid overwhelming Cover Art Archive
        for (let i = 0; i < albumsWithoutCovers.length; i += BATCH_SIZE) {
            const batch = albumsWithoutCovers.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (album) => {
                    if (!album.rgMbid || album.rgMbid.startsWith("temp-")) return;

                    try {
                        const coverUrl = await coverArtService.getCoverArt(
                            album.rgMbid
                        );

                        if (coverUrl) {
                            // Save to database
                            await prisma.album.update({
                                where: { id: album.id },
                                data: { coverUrl },
                            });

                            // Cache in Redis
                            try {
                                await redisClient.setex(
                                    `album-cover:${album.id}`,
                                    30 * 24 * 60 * 60, // 30 days
                                    coverUrl
                                );
                            } catch (err) {
                                // Redis errors are non-critical
                            }

                            fetchedCount++;
                        }
                    } catch (err) {
                        // Cover art fetch failed, continue with next album
                        logger.debug(`      No cover found for: ${album.title}`);
                    }
                })
            );
        }

        logger.debug(
            `    Fetched ${fetchedCount}/${albumsWithoutCovers.length} album covers`
        );
    } catch (error) {
        logger.error(`    Failed to enrich album covers:`, error);
        // Don't throw - album cover failures shouldn't fail the entire enrichment
    }
}
