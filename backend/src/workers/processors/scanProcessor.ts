import type { Job } from "bullmq";
import { logger } from "../../utils/logger";
import { MusicScannerService } from "../../services/musicScanner";
import { config } from "../../config";
import { eventBus } from "../../services/eventBus";
import { notificationService } from "../../services/notificationService";
import * as path from "path";

export interface ScanJobData {
    userId?: string; // Optional: scans can be triggered without a user
    musicPath?: string; // Optional: use custom path or default from config
    albumMbid?: string; // Optional: the album a download or retry brought in
    artistMbid?: string; // Optional: the artist of a retried track
    source?: string; // Optional: source of scan (e.g., "lidarr-webhook", "discover-weekly-completion", "spotify-import")
    discoveryBatchId?: string; // Optional: Discovery Weekly batch ID
    spotifyImportJobId?: string; // Optional: Spotify Import job ID
}

export interface ScanJobResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksMissing: number;
    tracksRemoved: number;
    tracksCorrupt: number;
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

const SCAN_RESULT_KEY = "library-scan";

function scanSummary(r: { tracksAdded: number; tracksUpdated: number; tracksMissing: number; tracksRemoved: number; tracksCorrupt: number }): string {
    const parts = [
        r.tracksAdded > 0 && `${r.tracksAdded} added`,
        r.tracksUpdated > 0 && `${r.tracksUpdated} updated`,
        r.tracksMissing > 0 && `${r.tracksMissing} missing`,
        r.tracksRemoved > 0 && `${r.tracksRemoved} retired`,
        r.tracksCorrupt > 0 && `${r.tracksCorrupt} corrupt`,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : "No changes";
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
        discoveryBatchId,
        spotifyImportJobId,
    } = job.data;
    const manual = source === "manual-scan";

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

    // Report progress
    await job.updateProgress(0);

    // Prepare cover cache path (store alongside transcode cache)
    const coverCachePath = path.join(
        config.music.transcodeCachePath,
        "../covers"
    );

    // Create scanner with progress callback and cover cache path
    let lastEmittedPercent = -1;
    const scanner = new MusicScannerService((progress) => {
        const percent = Math.floor(
            (progress.filesScanned / progress.filesTotal) * 100
        );
        job.updateProgress(percent).catch((err) =>
            logger.error(`Failed to update job progress:`, err)
        );
        // Emit SSE every 1% for smooth progress
        if (userId && percent >= lastEmittedPercent + 1) {
            lastEmittedPercent = percent;
            eventBus.emit({
                type: "scan:progress",
                userId,
                payload: { jobId: String(job.id), progress: percent },
            });
        }
    }, coverCachePath);

    // Use provided music path or fall back to config
    const scanPath = musicPath || config.music.musicPath;

    logger.debug(`[ScanJob ${job.id}] Scanning path: ${scanPath}`);

    try {
        const result = await scanner.scanLibrary(scanPath);

        await job.updateProgress(100);

        if (userId) {
            eventBus.emit({
                type: "scan:complete",
                userId,
                payload: {
                    jobId: String(job.id),
                    result: { tracksAdded: result.tracksAdded, tracksUpdated: result.tracksUpdated, tracksMissing: result.tracksMissing, tracksRemoved: result.tracksRemoved, tracksCorrupt: result.tracksCorrupt },
                },
            });
            if (manual) {
                await notificationService
                    .create({
                        userId,
                        type: "system",
                        title: "Library scan finished",
                        message: scanSummary(result),
                        groupKey: SCAN_RESULT_KEY,
                        renotify: true,
                    })
                    .catch((e) => logger.error(`[ScanJob ${job.id}] Failed to record scan result:`, e));
            }
        }

        logger.debug(
              `[ScanJob ${job.id}] Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} missing:${result.tracksMissing} corrupt:${result.tracksCorrupt}`
          );

        // A Lidarr import can bring a new artist: queue its enrichment now.
        if (source === "lidarr-webhook" && albumMbid) {
            try {
                const { prisma } = await import("../../utils/db");
                const album = await prisma.album.findFirst({
                    where: { rgMbid: albumMbid },
                    include: { artist: true },
                });
                if (album?.artist && album.artist.enrichmentStatus === "pending") {
                    // The queue's jobId dedupes against the enrichment loop's own run.
                    const { artistQueue } = await import("../enrichmentQueues");
                    const jobId = `artist-${album.artist.id}`;
                    if (!(await artistQueue.getJob(jobId))) {
                        await artistQueue.add(
                            "enrich",
                            { artistId: album.artist.id, artistName: album.artist.name },
                            { jobId }
                        );
                        await prisma.artist.update({
                            where: { id: album.artist.id },
                            data: { enrichmentStatus: "enriching" },
                        });
                    }
                }
            } catch (error) {
                logger.error(`[ScanJob ${job.id}] Failed to queue artist enrichment:`, error);
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

        // Complete download jobs whose albums are now in the library.
        try {
            const { queueCleaner } = await import("../../jobs/queueCleaner");
            await queueCleaner.reconcileWithLocalLibrary();
        } catch (error: any) {
            logger.error(`[ScanJob ${job.id}] Failed to reconcile download jobs:`, error.message);
        }

        // Reconcile Spotify-import pending tracks against new or updated tracks, manual syncs and retried downloads.
        const shouldReconcile =
            result.tracksAdded > 0 ||
            result.tracksUpdated > 0 ||
            manual ||
            source?.startsWith("retry-");
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
        // Run on: new tracks added OR manual sync
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

        // New files are owed every stage's answer; trigger the next cycle now rather
        // than after the 30 s wait.
        if (result.tracksAdded > 0) {
            try {
                logger.debug(
                    `[ScanJob ${job.id}] ${result.tracksAdded} new track(s) added — starting an enrichment cycle`
                );
                const { triggerEnrichmentNow } = await import(
                    "../unifiedEnrichment"
                );
                triggerEnrichmentNow()
                    .then((result) => {
                        if (result.tracks > 0) {
                            logger.debug(
                                `[ScanJob ${job.id}] Enrichment after scan completed: ${result.tracks} tracks`
                            );
                        }
                    })
                    .catch((err) => {
                        logger.error(
                            `[ScanJob ${job.id}] Enrichment for new tracks failed:`,
                            err
                        );
                    });
            } catch (error) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to trigger enrichment:`,
                    error
                );
            }
        }

        return result;
    } catch (error: any) {
        logger.error(`[ScanJob ${job.id}] Scan failed:`, error);
        if (userId) {
            eventBus.emit({
                type: "scan:complete",
                userId,
                payload: { jobId: String(job.id), error: error.message || "Scan failed" },
            });
            if (manual) {
                await notificationService
                    .create({
                        userId,
                        type: "error",
                        title: "Library scan failed",
                        message: error.message || undefined,
                        groupKey: SCAN_RESULT_KEY,
                        renotify: true,
                    })
                    .catch((e) => logger.error(`[ScanJob ${job.id}] Failed to record scan failure:`, e));
            }
        }
        throw error;
    }
}
