import { logger } from "../utils/logger";

interface DownloadInfo {
    downloadId: string;
    albumTitle: string;
    albumMbid: string;
    artistName: string;
    artistMbid?: string;
    albumId?: number;
    artistId?: number;
    attempts: number;
    startTime: number;
    userId?: string;
    tier?: string;
    similarity?: number;
}

type UnavailableAlbumCallback = (info: {
    albumTitle: string;
    artistName: string;
    albumMbid: string;
    artistMbid?: string;
    userId?: string;
    tier?: string;
    similarity?: number;
}) => Promise<void>;

class DownloadQueueManager {
    private activeDownloads = new Map<string, DownloadInfo>();
    private timeoutTimer: NodeJS.Timeout | null = null;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private readonly TIMEOUT_MINUTES = 10; // Trigger scan after 10 minutes regardless
    private readonly MAX_RETRY_ATTEMPTS = 3; // Max retries before giving up
    private readonly STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes - entries older than this are considered stale
    private unavailableCallbacks: UnavailableAlbumCallback[] = [];

    constructor() {
        // Start periodic cleanup of stale downloads (every 5 minutes)
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleDownloads();
        }, 5 * 60 * 1000);
    }

    /**
     * Track a new download
     */
    addDownload(
        downloadId: string,
        albumTitle: string,
        albumMbid: string,
        artistName: string,
        albumId?: number,
        artistId?: number,
        options?: {
            artistMbid?: string;
            userId?: string;
            tier?: string;
            similarity?: number;
        }
    ) {
        const info: DownloadInfo = {
            downloadId,
            albumTitle,
            albumMbid,
            artistName,
            artistMbid: options?.artistMbid,
            albumId,
            artistId,
            attempts: 1,
            startTime: Date.now(),
            userId: options?.userId,
            tier: options?.tier,
            similarity: options?.similarity,
        };

        this.activeDownloads.set(downloadId, info);
        logger.debug(
            `[DOWNLOAD] Started: "${albumTitle}" by ${artistName} (${downloadId})`
        );
        logger.debug(`   Album MBID: ${albumMbid}`);
        logger.debug(`   Active downloads: ${this.activeDownloads.size}`);

        // Persist Lidarr download reference to download job for later status updates
        this.linkDownloadJob(downloadId, albumMbid).catch((error) => {
            logger.error(` linkDownloadJob error:`, error);
        });

        // Start timeout on first download
        if (this.activeDownloads.size === 1 && !this.timeoutTimer) {
            this.startTimeout();
        }
    }

    /**
     * Register a callback to be notified when an album is unavailable
     */
    onUnavailableAlbum(callback: UnavailableAlbumCallback) {
        this.unavailableCallbacks.push(callback);
    }

    /**
     * Clear all unavailable album callbacks
     */
    clearUnavailableCallbacks() {
        this.unavailableCallbacks = [];
    }

    /**
     * Mark download as complete
     */
    async completeDownload(downloadId: string, albumTitle: string) {
        this.activeDownloads.delete(downloadId);
        logger.debug(`Download complete: "${albumTitle}" (${downloadId})`);
        logger.debug(`   Remaining downloads: ${this.activeDownloads.size}`);

        // If no more downloads, trigger refresh immediately
        if (this.activeDownloads.size === 0) {
            logger.debug(`⏰ All downloads complete! Starting refresh now...`);
            this.clearTimeout();
            this.triggerFullRefresh();
        }
    }

    /**
     * Mark download as failed and optionally retry
     */
    async failDownload(downloadId: string, reason: string) {
        const info = this.activeDownloads.get(downloadId);
        if (!info) {
            logger.debug(
                `  Download ${downloadId} not tracked, ignoring failure`
            );
            return;
        }

        logger.debug(` Download failed: "${info.albumTitle}" (${downloadId})`);
        logger.debug(`   Reason: ${reason}`);
        logger.debug(`   Attempt ${info.attempts}/${this.MAX_RETRY_ATTEMPTS}`);

        // Check if we should retry
        if (info.attempts < this.MAX_RETRY_ATTEMPTS) {
            info.attempts++;
            logger.debug(`    Retrying download... (attempt ${info.attempts})`);
            await this.retryDownload(info);
        } else {
            logger.debug(`   ⛔ Max retry attempts reached, giving up`);
            await this.cleanupFailedAlbum(info);
            this.activeDownloads.delete(downloadId);

            // Check if all downloads are done
            if (this.activeDownloads.size === 0) {
                logger.debug(
                    `⏰ All downloads finished (some failed). Starting refresh...`
                );
                this.clearTimeout();
                this.triggerFullRefresh();
            }
        }
    }

    /**
     * Retry a failed download by triggering Lidarr album search
     */
    private async retryDownload(info: DownloadInfo) {
        try {
            if (!info.albumId) {
                logger.debug(` No album ID, cannot retry`);
                return;
            }

            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();

            if (
                !settings.lidarrEnabled ||
                !settings.lidarrUrl ||
                !settings.lidarrApiKey
            ) {
                logger.debug(` Lidarr not configured`);
                return;
            }

            const axios = (await import("axios")).default;

            // Trigger new album search
            await axios.post(
                `${settings.lidarrUrl}/api/v1/command`,
                {
                    name: "AlbumSearch",
                    albumIds: [info.albumId],
                },
                {
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 10000,
                }
            );

            logger.debug(`   Retry search triggered in Lidarr`);
        } catch (error: any) {
            logger.debug(` Failed to retry: ${error.message}`);
        }
    }

    /**
     * Clean up failed album from Lidarr and Discovery database
     */
    private async cleanupFailedAlbum(info: DownloadInfo) {
        try {
            logger.debug(`    Cleaning up failed album: ${info.albumTitle}`);

            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();

            if (
                !settings.lidarrEnabled ||
                !settings.lidarrUrl ||
                !settings.lidarrApiKey
            ) {
                return;
            }

            const axios = (await import("axios")).default;

            // Delete album from Lidarr
            if (info.albumId) {
                try {
                    await axios.delete(
                        `${settings.lidarrUrl}/api/v1/album/${info.albumId}`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );
                    logger.debug(`   Removed album from Lidarr`);
                } catch (error: any) {
                    logger.debug(` Failed to remove album: ${error.message}`);
                }
            }

            // Check if artist has any other albums
            if (info.artistId) {
                try {
                    const artistResponse = await axios.get(
                        `${settings.lidarrUrl}/api/v1/artist/${info.artistId}`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );

                    const artist = artistResponse.data;
                    const monitoredAlbums =
                        artist.albums?.filter((a: any) => a.monitored) || [];

                    // If no other monitored albums, remove artist
                    if (monitoredAlbums.length === 0) {
                        await axios.delete(
                            `${settings.lidarrUrl}/api/v1/artist/${info.artistId}`,
                            {
                                params: { deleteFiles: false },
                                headers: { "X-Api-Key": settings.lidarrApiKey },
                                timeout: 10000,
                            }
                        );
                        logger.debug(
                            `   Removed artist from Lidarr (no other albums)`
                        );
                    }
                } catch (error: any) {
                    logger.debug(
                        ` Failed to check/remove artist: ${error.message}`
                    );
                }
            }

            // Mark as deleted in Discovery database (closest to failed status)
            const { prisma } = await import("../utils/db");
            await prisma.discoveryAlbum.updateMany({
                where: { albumTitle: info.albumTitle },
                data: { status: "DELETED" },
            });
            logger.debug(`   Marked as failed in database`);

            // Notify callbacks about unavailable album
            logger.debug(
                `   [NOTIFY] Notifying ${this.unavailableCallbacks.length} callbacks about unavailable album`
            );
            for (const callback of this.unavailableCallbacks) {
                try {
                    await callback({
                        albumTitle: info.albumTitle,
                        artistName: info.artistName,
                        albumMbid: info.albumMbid,
                        artistMbid: info.artistMbid,
                        userId: info.userId,
                        tier: info.tier,
                        similarity: info.similarity,
                    });
                } catch (error: any) {
                    logger.debug(` Callback error: ${error.message}`);
                }
            }
        } catch (error: any) {
            logger.debug(` Cleanup error: ${error.message}`);
        }
    }

    /**
     * Start timeout to trigger scan after X minutes even if downloads are still pending
     */
    private startTimeout() {
        const timeoutMs = this.TIMEOUT_MINUTES * 60 * 1000;
        logger.debug(
            `[TIMER] Starting ${this.TIMEOUT_MINUTES}-minute timeout for automatic scan`
        );

        this.timeoutTimer = setTimeout(() => {
            if (this.activeDownloads.size > 0) {
                logger.debug(
                    `\n  Timeout reached! ${this.activeDownloads.size} downloads still pending.`
                );
                logger.debug(`   These downloads never completed:`);

                // Collect IDs first to avoid mutating the Map during iteration
                const toFail: string[] = [];
                for (const [downloadId, info] of this.activeDownloads) {
                    logger.debug(
                        `     - ${info.albumTitle} by ${info.artistName}`
                    );
                    toFail.push(downloadId);
                }
                for (const downloadId of toFail) {
                    this.failDownload(
                        downloadId,
                        "Download timeout - never completed"
                    ).catch((err) => {
                        logger.error(
                            `Error failing download ${downloadId}:`,
                            err
                        );
                    });
                }

                logger.debug(
                    `   Triggering scan anyway to process completed downloads...\n`
                );
            } else {
                this.triggerFullRefresh();
            }
        }, timeoutMs);
    }

    /**
     * Clear the timeout timer
     */
    private clearTimeout() {
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
    }

    /**
     * Trigger full library refresh (Lidarr cleanup → Lidify sync)
     */
    private async triggerFullRefresh() {
        try {
            logger.debug("\n Starting full library refresh...\n");

            // Step 1: Clear failed imports from Lidarr
            logger.debug("[1/2] Checking for failed imports in Lidarr...");
            await this.clearFailedLidarrImports();

            // Step 2: Trigger Lidify library sync
            logger.debug("[2/2] Triggering Lidify library sync...");
            const lidifySuccess = await this.triggerLidifySync();

            if (!lidifySuccess) {
                logger.error(" Lidify sync failed");
                return;
            }

            logger.debug("Lidify sync started");
            logger.debug(
                "\n[SUCCESS] Full library refresh complete! New music should appear shortly.\n"
            );
        } catch (error) {
            logger.error(" Library refresh error:", error);
        }
    }

    /**
     * Clear failed imports from Lidarr queue
     */
    private async clearFailedLidarrImports(): Promise<void> {
        try {
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();

            if (!settings.lidarrEnabled || !settings.lidarrUrl) {
                logger.debug(" Lidarr not configured, skipping");
                return;
            }

            const axios = (await import("axios")).default;

            // Get Lidarr API key
            const apiKey = settings.lidarrApiKey;
            if (!apiKey) {
                logger.debug(" Lidarr API key not found, skipping");
                return;
            }

            // Get queue
            const response = await axios.get(
                `${settings.lidarrUrl}/api/v1/queue`,
                {
                    headers: { "X-Api-Key": apiKey },
                    timeout: 10000,
                }
            );

            const queue = response.data.records || [];

            // Find failed imports
            const failed = queue.filter(
                (item: any) =>
                    item.trackedDownloadStatus === "warning" ||
                    item.trackedDownloadStatus === "error" ||
                    item.status === "warning" ||
                    item.status === "failed"
            );

            if (failed.length === 0) {
                logger.debug("   No failed imports found");
                return;
            }

            logger.debug(` Found ${failed.length} failed import(s)`);

            for (const item of failed) {
                const artistName =
                    item.artist?.artistName || item.artist?.name || "Unknown";
                const albumTitle =
                    item.album?.title || item.album?.name || "Unknown Album";

                logger.debug(`       ${artistName} - ${albumTitle}`);

                try {
                    // Remove from queue, blocklist, and trigger search
                    await axios.delete(
                        `${settings.lidarrUrl}/api/v1/queue/${item.id}`,
                        {
                            params: {
                                removeFromClient: true,
                                blocklist: true,
                            },
                            headers: { "X-Api-Key": apiKey },
                            timeout: 10000,
                        }
                    );

                    // Trigger new search if album ID is available
                    if (item.album?.id) {
                        await axios.post(
                            `${settings.lidarrUrl}/api/v1/command`,
                            {
                                name: "AlbumSearch",
                                albumIds: [item.album.id],
                            },
                            {
                                headers: { "X-Api-Key": apiKey },
                                timeout: 10000,
                            }
                        );
                        logger.debug(
                            `         → Blocklisted and searching for alternative`
                        );
                    } else {
                        logger.debug(
                            `         → Blocklisted (no album ID for re-search)`
                        );
                    }
                } catch (error: any) {
                    logger.debug(`       Failed to process: ${error.message}`);
                }
            }

            logger.debug(`   Cleared ${failed.length} failed import(s)`);
        } catch (error: any) {
            logger.debug(` Failed to check Lidarr queue: ${error.message}`);
        }
    }

    /**
     * Trigger Lidify library sync
     */
    private async triggerLidifySync(): Promise<boolean> {
        try {
            const { scanQueue } = await import("../workers/queues");
            const { prisma } = await import("../utils/db");

            logger.debug("   Starting library scan...");

            // Get first user for scanning
            const firstUser = await prisma.user.findFirst();
            if (!firstUser) {
                logger.error(` No users found in database, cannot scan`);
                return false;
            }

            // Trigger scan via queue
            await scanQueue.add("scan", {
                userId: firstUser.id,
                source: "download-queue",
            });

            logger.debug("Library scan queued");
            return true;
        } catch (error: any) {
            logger.error("Lidify sync trigger error:", error.message);
            return false;
        }
    }

    /**
     * Get current queue status
     */
    getStatus() {
        return {
            activeDownloads: this.activeDownloads.size,
            downloads: Array.from(this.activeDownloads.values()),
            timeoutActive: this.timeoutTimer !== null,
        };
    }

    /**
     * Get the active downloads map (for checking if a download is being tracked)
     */
    getActiveDownloads() {
        return this.activeDownloads;
    }

    /**
     * Manually trigger a full refresh (for testing or manual triggers)
     */
    async manualRefresh() {
        logger.debug("\n Manual refresh triggered...\n");
        await this.triggerFullRefresh();
    }

    /**
     * Clean up stale downloads that have been active for too long
     * This prevents the activeDownloads Map from growing unbounded
     */
    cleanupStaleDownloads(): number {
        const now = Date.now();
        const toClean: string[] = [];

        for (const [downloadId, info] of this.activeDownloads) {
            const age = now - info.startTime;
            if (age > this.STALE_TIMEOUT_MS) {
                logger.debug(
                    `[CLEANUP] Cleaning up stale download: "${
                        info.albumTitle
                    }" (${downloadId}) - age: ${Math.round(
                        age / 60000
                    )} minutes`
                );
                toClean.push(downloadId);
            }
        }

        for (const downloadId of toClean) {
            this.activeDownloads.delete(downloadId);
        }
        const cleanedCount = toClean.length;

        if (cleanedCount > 0) {
            logger.debug(
                `[CLEANUP] Cleaned up ${cleanedCount} stale download(s)`
            );
        }

        return cleanedCount;
    }

    /**
     * Reconcile in-memory state with database on startup
     * - Mark stale jobs (>30 min without update) as failed
     * - Load active/processing jobs into memory
     */
    async reconcileOnStartup(): Promise<{ loaded: number; failed: number }> {
        const { prisma } = await import("../utils/db");
        
        const staleThreshold = new Date(Date.now() - this.STALE_TIMEOUT_MS);
        
        // Mark stale processing jobs as failed
        const staleResult = await prisma.downloadJob.updateMany({
            where: {
                status: "processing",
                startedAt: { lt: staleThreshold }
            },
            data: {
                status: "failed",
                error: "Server restart - download was processing but never completed"
            }
        });
        
        logger.debug(`[DOWNLOAD] Marked ${staleResult.count} stale downloads as failed`);
        
        // Load recent processing jobs into memory (not stale)
        const activeJobs = await prisma.downloadJob.findMany({
            where: {
                status: "processing",
                startedAt: { gte: staleThreshold }
            },
            select: {
                id: true,
                subject: true,
                targetMbid: true,
                lidarrRef: true,
                metadata: true,
                startedAt: true,
                attempts: true
            }
        });
        
        // Populate in-memory map from database
        for (const job of activeJobs) {
            const metadata = job.metadata as Record<string, any> || {};
            this.activeDownloads.set(job.lidarrRef || job.id, {
                downloadId: job.lidarrRef || job.id,
                albumTitle: job.subject,
                albumMbid: job.targetMbid,
                artistName: metadata.artistName || "Unknown",
                artistMbid: metadata.artistMbid,
                albumId: metadata.lidarrAlbumId,
                artistId: metadata.lidarrArtistId,
                attempts: job.attempts,
                startTime: job.startedAt?.getTime() || Date.now(),
                userId: metadata.userId,
                tier: metadata.tier,
                similarity: metadata.similarity
            });
        }
        
        logger.debug(`[DOWNLOAD] Loaded ${activeJobs.length} active downloads from database`);
        
        return { loaded: activeJobs.length, failed: staleResult.count };
    }

    /**
     * Shutdown the download queue manager (cleanup resources)
     */
    shutdown() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.clearTimeout();
        this.activeDownloads.clear();
        logger.debug("Download queue manager shutdown");
    }

    /**
     * Link Lidarr download IDs to download jobs (so we can mark them completed later)
     */
    private async linkDownloadJob(downloadId: string, albumMbid: string) {
        logger.debug(
            `   [LINK] Attempting to link download job for MBID: ${albumMbid}`
        );
        try {
            const { prisma } = await import("../utils/db");

            // Debug: Check if job exists
            const existingJobs = await prisma.downloadJob.findMany({
                where: { targetMbid: albumMbid },
                select: {
                    id: true,
                    status: true,
                    lidarrRef: true,
                    targetMbid: true,
                },
            });
            logger.debug(
                `   [LINK] Found ${existingJobs.length} job(s) with this MBID:`,
                JSON.stringify(existingJobs, null, 2)
            );

            const result = await prisma.downloadJob.updateMany({
                where: {
                    targetMbid: albumMbid,
                    status: { in: ["pending", "processing"] },
                    OR: [{ lidarrRef: null }, { lidarrRef: "" }],
                },
                data: {
                    lidarrRef: downloadId,
                    status: "processing",
                    startedAt: new Date(),
                },
            });

            if (result.count === 0) {
                logger.debug(
                    `     No matching download jobs found to link with Lidarr ID ${downloadId}`
                );
                logger.debug(
                    ` This means either: no job exists, job already has lidarrRef, or status is not pending/processing`
                );
            } else {
                logger.debug(
                    `   Linked Lidarr download ${downloadId} to ${result.count} download job(s)`
                );
            }
        } catch (error: any) {
            logger.error(
                ` Failed to persist Lidarr download link:`,
                error.message
            );
            logger.error(`   Error details:`, error);
        }
    }
}

// Singleton instance
export const downloadQueueManager = new DownloadQueueManager();
