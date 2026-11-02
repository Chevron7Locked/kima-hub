import type { Job } from "bullmq";
import { logger } from "../../utils/logger";
import { MusicScannerService, type ScanResult } from "../../services/musicScanner";
import { config } from "../../config";
import { eventBus } from "../../services/eventBus";
import { notificationService } from "../../services/notificationService";
import { coversBasePath } from "../../services/imageStorage";

export interface ScanJobData {
    /** Absent for scans nobody asked for. */
    userId?: string;
    /** The album a download or retry brought in. */
    albumMbid?: string;
    /** The artist of a retried track. */
    artistMbid?: string;
    /** What asked for the scan ("manual-scan", "lidarr-webhook", "discover-weekly-completion", "spotify-import", "retry-…"). */
    source?: string;
    discoveryBatchId?: string;
    spotifyImportJobId?: string;
}

const SCAN_RESULT_KEY = "library-scan";

type ScanCounts = Pick<ScanResult, "tracksAdded" | "tracksUpdated" | "tracksMissing" | "tracksRemoved" | "tracksCorrupt">;

function scanSummary(r: ScanCounts): string {
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
): Promise<ScanResult> {
    const {
        userId,
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

    await job.updateProgress(0);

    let lastEmittedPercent = -1;
    const scanner = new MusicScannerService((progress) => {
        const percent = Math.floor(
            (progress.filesScanned / progress.filesTotal) * 100
        );
        job.updateProgress(percent).catch((err) =>
            logger.error(`Failed to update job progress:`, err)
        );
        if (userId && percent >= lastEmittedPercent + 1) {
            lastEmittedPercent = percent;
            eventBus.emit({
                type: "scan:progress",
                userId,
                payload: { jobId: String(job.id), progress: percent },
            });
        }
    }, coversBasePath());

    // The music folder in use when the scan runs, so a folder changed in Settings is the one scanned.
    const scanPath = config.music.musicPath;

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
                    result: { tracksAdded: result.tracksAdded, tracksUpdated: result.tracksUpdated, tracksMissing: result.tracksMissing, tracksRemoved: result.tracksRemoved, tracksCorrupt: result.tracksCorrupt } satisfies ScanCounts,
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

        // The scan after a Discover batch's downloads builds its playlist.
        if (source === "discover-weekly-completion" && discoveryBatchId) {
            logger.debug(
                `[ScanJob ${job.id}] Building Discovery Weekly playlist for batch ${discoveryBatchId}`
            );
            try {
                const { discoverWeeklyService } = await import(
                    "../../services/discoverWeekly"
                );
                await discoverWeeklyService.buildFinalPlaylist(
                    discoveryBatchId
                );
                logger.debug(
                    `[ScanJob ${job.id}] Discovery Weekly playlist complete`
                );
            } catch (error: any) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to build Discovery playlist:`,
                    error.message
                );
            }
        }

        // The scan after a Spotify import's downloads builds its playlist.
        if (source === "spotify-import" && spotifyImportJobId) {
            logger.debug(
                `[ScanJob ${job.id}] Building Spotify Import playlist for job ${spotifyImportJobId}`
            );
            try {
                const { spotifyImportService } = await import(
                    "../../services/spotifyImport"
                );
                await spotifyImportService.buildPlaylistAfterScan(
                    spotifyImportJobId
                );
                logger.debug(
                    `[ScanJob ${job.id}] Spotify Import playlist complete`
                );
            } catch (error: any) {
                logger.error(
                    `[ScanJob ${job.id}] Failed to build Spotify Import playlist:`,
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

        // Songs still waiting in imported and Discover playlists are matched again when the scan added or updated
        // songs, was asked for by hand, or followed a retried download.
        if (result.tracksAdded > 0 || result.tracksUpdated > 0 || manual || source?.startsWith("retry-")) {
            try {
                const { spotifyImportService } = await import("../../services/spotifyImport");
                const reconciled = await spotifyImportService.reconcilePendingTracks();
                logger.debug(
                    `[ScanJob ${job.id}] Reconciled ${reconciled.tracksAdded} pending tracks to ${reconciled.playlistsUpdated} playlists`,
                );
            } catch (error) {
                logger.error(`[ScanJob ${job.id}] Failed to reconcile pending tracks:`, error);
            }
            try {
                const { discoverWeeklyService } = await import("../../services/discoverWeekly");
                const discoverResult = await discoverWeeklyService.reconcileDiscoveryTracks();
                if (discoverResult.tracksAdded > 0) {
                    logger.info(
                        `[SCAN] Discovery Weekly reconciliation: ${discoverResult.tracksAdded} tracks added across ${discoverResult.batchesChecked} batches`,
                    );
                }
            } catch (error) {
                logger.error("[SCAN] Discovery Weekly reconciliation failed:", error);
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
