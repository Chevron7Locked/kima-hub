import { Job } from "bull";
import { logger } from "../../utils/logger";
import { MusicScannerService } from "../../services/musicScanner";
import { config } from "../../config";
import * as path from "path";

/**
 * Reconcile pending/processing download jobs with newly scanned albums
 * This is called after every scan to catch downloads that completed but webhooks failed
 * Part of Phase 2 & 3 fix for #31
 *
 * Phase 3 enhancement: Uses fuzzy matching to catch more name variations
 */
async function reconcileDownloadJobsWithScan(): Promise<number> {
    const { prisma } = await import("../../utils/db");

    // Get all pending/processing download jobs
    const activeJobs = await prisma.downloadJob.findMany({
        where: { status: { in: ["pending", "processing"] } },
    });

    if (activeJobs.length === 0) {
        return 0;
    }

    let reconciled = 0;

    for (const job of activeJobs) {
        const metadata = (job.metadata as any) || {};
        const artistName = metadata?.artistName;
        const albumTitle = metadata?.albumTitle;

        if (!artistName || !albumTitle) {
            continue;
        }

        try {
            // First try: Exact/contains match (fast)
            let album = await prisma.album.findFirst({
                where: {
                    AND: [
                        {
                            artist: {
                                name: {
                                    contains: artistName,
                                    mode: "insensitive",
                                },
                            },
                        },
                        {
                            title: {
                                contains: albumTitle,
                                mode: "insensitive",
                            },
                        },
                    ],
                },
                include: {
                    tracks: {
                        select: { id: true },
                        take: 1,
                    },
                    artist: {
                        select: { name: true },
                    },
                },
            });

            // Second try: Fuzzy match if exact match failed
            if (!album || album.tracks.length === 0) {
                const { matchAlbum } = await import("../../utils/fuzzyMatch");

                // Get candidate albums
                const candidates = await prisma.album.findMany({
                    where: {
                        artist: {
                            name: {
                                contains: artistName.substring(0, 5),
                                mode: "insensitive",
                            },
                        },
                    },
                    include: {
                        tracks: {
                            select: { id: true },
                            take: 1,
                        },
                        artist: {
                            select: { name: true },
                        },
                    },
                    take: 50,
                });

                const fuzzyMatch = candidates.find(
                    (candidate) =>
                        candidate.tracks.length > 0 &&
                        matchAlbum(
                            artistName,
                            albumTitle,
                            candidate.artist.name,
                            candidate.title,
                            0.75
                        )
                );

                if (fuzzyMatch) {
                    album = fuzzyMatch;
                }
            }

            if (album && album.tracks.length > 0) {
                // Album exists with tracks - mark job complete
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                        error: null,
                        metadata: {
                            ...metadata,
                            completedAt: new Date().toISOString(),
                            reconciledFromScan: true,
                        },
                    },
                });

                reconciled++;

                // Check batch completion for discovery jobs
                if (job.discoveryBatchId) {
                    const { discoverWeeklyService } = await import(
                        "../../services/discoverWeekly"
                    );
                    await discoverWeeklyService.checkBatchCompletion(
                        job.discoveryBatchId
                    );
                }
            }
        } catch (error: any) {
            logger.error(
                `[SCAN-RECONCILE] Error checking job ${job.id}:`,
                error.message
            );
        }
    }

    return reconciled;
}

export interface ScanJobData {
    userId: string;
    musicPath?: string; // Optional: use custom path or default from config
    albumMbid?: string; // Optional: if scan triggered by download completion
    artistMbid?: string; // Optional: if scan triggered by download completion
    source?: string; // Optional: source of scan (e.g., "lidarr-webhook", "discover-weekly-completion", "spotify-import")
    downloadId?: string; // Optional: Lidarr download ID for precise job linking
    discoveryBatchId?: string; // Optional: Discovery Weekly batch ID
    spotifyImportJobId?: string; // Optional: Spotify Import job ID
}

export interface ScanJobResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksRemoved: number;
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

export async function processScan(
    job: Job<ScanJobData>
): Promise<ScanJobResult> {
    const {
        userId,
        musicPath,
        albumMbid,
        artistMbid,
        source,
        downloadId,
        discoveryBatchId,
        spotifyImportJobId,
    } = job.data;

    logger.debug(`\n═══════════════════════════════════════════════`);
    logger.debug(`[ScanJob ${job.id}] Starting library scan for user ${userId}`);
    if (source) {
        logger.debug(`[ScanJob ${job.id}] Scan source: ${source}`);
    }
    if (albumMbid) {
        logger.debug(`[ScanJob ${job.id}] Album MBID: ${albumMbid}`);
    }
    if (artistMbid) {
        logger.debug(`[ScanJob ${job.id}] Artist MBID: ${artistMbid}`);
    }
    logger.debug(`═══════════════════════════════════════════════`);

    // Report progress
    await job.progress(0);

    // Prepare cover cache path (store alongside transcode cache)
    const coverCachePath = path.join(
        config.music.transcodeCachePath,
        "../covers"
    );

    // Create scanner with progress callback and cover cache path
    const scanner = new MusicScannerService((progress) => {
        // Calculate percentage (filesScanned / filesTotal * 100)
        const percent = Math.floor(
            (progress.filesScanned / progress.filesTotal) * 100
        );
        job.progress(percent).catch((err) =>
            logger.error(`Failed to update job progress:`, err)
        );
    }, coverCachePath);

    // Use provided music path or fall back to config
    const scanPath = musicPath || config.music.musicPath;

    logger.debug(`[ScanJob ${job.id}] Scanning path: ${scanPath}`);

    try {
        const result = await scanner.scanLibrary(scanPath);

        await job.progress(100);

        logger.debug(
            `[ScanJob ${job.id}] Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved}`
        );

        // If this scan was triggered by a download completion, mark download jobs as completed
        if (
            source?.startsWith("lidarr-") &&
            (albumMbid || artistMbid || downloadId)
        ) {
            logger.debug(
                `[ScanJob ${job.id}] Marking download jobs as completed after successful scan`
            );
            const { prisma } = await import("../../utils/db");

            if (artistMbid) {
                await prisma.downloadJob.updateMany({
                    where: {
                        targetMbid: artistMbid,
                        type: "artist",
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });
                logger.debug(
                    `[ScanJob ${job.id}] Marked artist download as completed: ${artistMbid}`
                );

                // Trigger enrichment for the newly imported artist
                try {
                    const artist = await prisma.artist.findUnique({
                        where: { mbid: artistMbid },
                    });
                    if (artist && artist.enrichmentStatus === "pending") {
                        logger.debug(
                            `[ScanJob ${job.id}] Triggering enrichment for artist: ${artist.name}`
                        );
                        const { enrichSimilarArtist } = await import(
                            "../artistEnrichment"
                        );
                        // Run enrichment in background (don't await)
                        enrichSimilarArtist(artist).catch((err) => {
                            logger.error(
                                `[ScanJob ${job.id}]  Enrichment failed for ${artist.name}:`,
                                err
                            );
                        });
                    }
                } catch (error) {
                    logger.error(
                        `[ScanJob ${job.id}]   Failed to trigger enrichment:`,
                        error
                    );
                }
            }

            if (albumMbid) {
                const updatedByMbid = await prisma.downloadJob.updateMany({
                    where: {
                        targetMbid: albumMbid,
                        type: "album",
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });

                if (updatedByMbid.count > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] Marked ${updatedByMbid.count} album download(s) as completed by MBID: ${albumMbid}`
                    );
                } else {
                    // Fallback: Try to find the album by artist+title and match download jobs
                    logger.debug(
                        `[ScanJob ${job.id}] No downloads matched by MBID, trying artist+title match...`
                    );

                    const album = await prisma.album.findFirst({
                        where: { rgMbid: albumMbid },
                        include: { artist: true },
                    });

                    if (album) {
                        const updatedByName =
                            await prisma.downloadJob.updateMany({
                                where: {
                                    type: "album",
                                    status: { in: ["pending", "processing"] },
                                    metadata: {
                                        path: ["albumTitle"],
                                        equals: album.title,
                                    },
                                },
                                data: {
                                    status: "completed",
                                    completedAt: new Date(),
                                },
                            });

                        if (updatedByName.count > 0) {
                            logger.debug(
                                `[ScanJob ${job.id}] Marked ${updatedByName.count} album download(s) as completed by title match: ${album.artist.name} - ${album.title}`
                            );
                        } else {
                            logger.debug(
                                `[ScanJob ${job.id}]   No pending downloads found for: ${album.artist.name} - ${album.title}`
                            );
                        }
                    }
                }

                // Trigger enrichment for the artist of the newly imported album
                try {
                    const album = await prisma.album.findFirst({
                        where: { rgMbid: albumMbid },
                        include: { artist: true },
                    });
                    if (
                        album?.artist &&
                        album.artist.enrichmentStatus === "pending"
                    ) {
                        logger.debug(
                            `[ScanJob ${job.id}] Triggering enrichment for artist: ${album.artist.name}`
                        );
                        const { enrichSimilarArtist } = await import(
                            "../artistEnrichment"
                        );
                        // Run enrichment in background (don't await)
                        enrichSimilarArtist(album.artist).catch((err) => {
                            logger.error(
                                `[ScanJob ${job.id}]  Enrichment failed for ${album.artist.name}:`,
                                err
                            );
                        });
                    }
                } catch (error) {
                    logger.error(
                        `[ScanJob ${job.id}]   Failed to trigger enrichment:`,
                        error
                    );
                }
            }

            if (downloadId) {
                const updated = await prisma.downloadJob.updateMany({
                    where: {
                        lidarrRef: downloadId,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });
                if (updated.count > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] Linked Lidarr download ${downloadId} to ${updated.count} job(s)`
                    );
                } else {
                    logger.debug(
                        `[ScanJob ${job.id}]   No download jobs found for Lidarr ID ${downloadId}`
                    );
                }
            }
        }

        // If this scan was for Discovery Weekly, build the final playlist
        if (source === "discover-weekly-completion" && discoveryBatchId) {
            logger.debug(
                `[ScanJob ${job.id}]  Building Discovery Weekly playlist for batch ${discoveryBatchId}...`
            );
            try {
                const { discoverWeeklyService } = await import(
                    "../../services/discoverWeekly"
                );
                await discoverWeeklyService.buildFinalPlaylist(
                    discoveryBatchId
                );
                logger.debug(
                    `[ScanJob ${job.id}] Discovery Weekly playlist complete!`
                );
            } catch (error: any) {
                logger.error(
                    `[ScanJob ${job.id}]  Failed to build Discovery playlist:`,
                    error.message
                );
            }
        }

        // If this scan was for Spotify Import, build the final playlist
        if (source === "spotify-import" && spotifyImportJobId) {
            logger.debug(
                `[ScanJob ${job.id}]  Building Spotify Import playlist for job ${spotifyImportJobId}...`
            );
            try {
                const { spotifyImportService } = await import(
                    "../../services/spotifyImport"
                );
                await spotifyImportService.buildPlaylistAfterScan(
                    spotifyImportJobId
                );
                logger.debug(
                    `[ScanJob ${job.id}] Spotify Import playlist complete!`
                );
            } catch (error: any) {
                logger.error(
                    `[ScanJob ${job.id}]  Failed to build Spotify Import playlist:`,
                    error.message
                );
            }
        }

        // Phase 2 Fix for #31: Reconcile download jobs with newly scanned albums
        // This runs after EVERY scan to catch albums that were downloaded but webhooks failed
        if (result.tracksAdded > 0) {
            logger.debug(
                `[ScanJob ${job.id}] Reconciling download jobs with ${result.tracksAdded} newly scanned tracks...`
            );
            try {
                const reconciledJobs = await reconcileDownloadJobsWithScan();
                if (reconciledJobs > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] ✓ Reconciled ${reconciledJobs} download job(s) with scanned albums`
                    );
                }
            } catch (error: any) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to reconcile download jobs:`,
                    error.message
                );
            }
        }

        // Send notification for manual scans (not background/webhook scans)
        if (!source && userId && userId !== "system") {
            try {
                const { notificationService } = await import(
                    "../../services/notificationService"
                );
                await notificationService.notifySystem(
                    userId,
                    "Library Scan Complete",
                    `Added ${result.tracksAdded} tracks, updated ${result.tracksUpdated}, removed ${result.tracksRemoved}`
                );
            } catch (error) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to send notification:`,
                    error
                );
            }
        }

        // Reconcile pending tracks from Spotify playlist imports
        // This checks if any previously unmatched tracks now have matches
        // Run on: new tracks added OR manual sync (no source = manual scan button)
        const shouldReconcile = result.tracksAdded > 0 || !source;
        if (shouldReconcile) {
            try {
                logger.debug(
                    `[ScanJob ${job.id}] Checking for pending playlist tracks to reconcile...`
                );
                const { spotifyImportService } = await import(
                    "../../services/spotifyImport"
                );
                const reconcileResult =
                    await spotifyImportService.reconcilePendingTracks();
                if (reconcileResult.tracksAdded > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] ✓ Reconciled ${reconcileResult.tracksAdded} pending tracks to ${reconcileResult.playlistsUpdated} playlists`
                    );

                    // Send notification about reconciled tracks
                    if (userId && userId !== "system") {
                        try {
                            const { notificationService } = await import(
                                "../../services/notificationService"
                            );
                            await notificationService.notifySystem(
                                userId,
                                "Playlist Tracks Matched",
                                `${reconcileResult.tracksAdded} previously unmatched tracks were added to your playlists`
                            );
                        } catch (notifyError) {
                            logger.error(
                                `[ScanJob ${job.id}] Failed to send reconcile notification:`,
                                notifyError
                            );
                        }
                    }
                } else {
                    logger.debug(
                        `[ScanJob ${job.id}] No pending tracks to reconcile`
                    );
                }
            } catch (error) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to reconcile pending tracks:`,
                    error
                );
            }
        }

        // Reconcile Discovery Weekly tracks
        // This backfills Discovery Weekly playlists with albums that downloaded after initial playlist creation
        // Run on: new tracks added OR manual sync (no source = manual scan button)
        if (shouldReconcile) {
            try {
                logger.debug(
                    `[ScanJob ${job.id}] Checking for Discovery Weekly tracks to reconcile...`
                );
                const { discoverWeeklyService } = await import(
                    "../../services/discoverWeekly"
                );
                const discoverResult = await discoverWeeklyService.reconcileDiscoveryTracks();
                if (discoverResult.tracksAdded > 0) {
                    logger.info(
                        `[SCAN] Discovery Weekly reconciliation: ${discoverResult.tracksAdded} tracks added across ${discoverResult.batchesChecked} batches`
                    );
                }
            } catch (error) {
                logger.error('[SCAN] Discovery Weekly reconciliation failed:', error);
            }
        }

        // Trigger mood tag collection for new tracks whose artists are already enriched
        // This ensures Last.fm mood tags are collected immediately after scan, not waiting 30s for background worker
        if (result.tracksAdded > 0) {
            try {
                logger.debug(
                    `[ScanJob ${job.id}] Checking for tracks needing mood tag enrichment...`
                );
                const { prisma } = await import("../../utils/db");

                // Count new tracks that need mood tags
                // Note: We don't filter by artist enrichmentStatus here because
                // triggerEnrichmentNow() runs runEnrichmentCycle() which handles
                // artist enrichment first (Step 1), then track tags (Step 2)
                const tracksNeedingTags = await prisma.track.count({
                    where: {
                        OR: [
                            { lastfmTags: { isEmpty: true } },
                            { lastfmTags: { equals: null } },
                        ],
                    },
                });

                if (tracksNeedingTags > 0) {
                    logger.debug(
                        `[ScanJob ${job.id}] Found ${tracksNeedingTags} tracks needing mood tags, triggering enrichment...`
                    );

                    // Trigger immediate enrichment cycle (non-blocking)
                    const { triggerEnrichmentNow } = await import(
                        "../unifiedEnrichment"
                    );
                    triggerEnrichmentNow()
                        .then((result) => {
                            if (result.tracks > 0) {
                                logger.debug(
                                    `[ScanJob ${job.id}] Mood tag enrichment completed: ${result.tracks} tracks enriched`
                                );
                            }
                        })
                        .catch((err) => {
                            logger.error(
                                `[ScanJob ${job.id}] Mood tag enrichment failed:`,
                                err
                            );
                        });
                } else {
                    logger.debug(
                        `[ScanJob ${job.id}] No tracks need immediate mood tag enrichment`
                    );
                }
            } catch (error) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to check for mood tag enrichment:`,
                    error
                );
            }
        }

        return result;
    } catch (error: any) {
        logger.error(`[ScanJob ${job.id}] Scan failed:`, error);
        throw error;
    }
}
