import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { requestScan } from "../workers/scanRequest";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { artistIdentityKey } from "../services/artistIdentity";
import { editionlessKey } from "../services/albumIdentity";

class QueueCleanerService {
    // Imported on first use and cached
    private discoverWeeklyService: typeof import("../services/discoverWeekly")["discoverWeeklyService"] | null = null;
    private spotifyImportService: typeof import("../services/spotifyImport")["spotifyImportService"] | null = null;

    private async getDiscoverWeeklyService() {
        if (!this.discoverWeeklyService) {
            const module = await import("../services/discoverWeekly");
            this.discoverWeeklyService = module.discoverWeeklyService;
        }
        return this.discoverWeeklyService;
    }

    private async getSpotifyImportService() {
        if (!this.spotifyImportService) {
            const module = await import("../services/spotifyImport");
            this.spotifyImportService = module.spotifyImportService;
        }
        return this.spotifyImportService;
    }

    /**
     * Moves on Discover batches and Spotify imports that stopped making progress: past their
     * deadline a batch is completed or failed and an import re-scanned or failed. Runs on a
     * schedule whatever the download source.
     */
    async recoverStuckWork(): Promise<void> {
        const [batches, imports] = await Promise.all([
            prisma.discoveryBatch.count({ where: { status: { in: ["downloading", "scanning"] } } }),
            prisma.spotifyImportJob.count({ where: { status: { in: ["scanning", "downloading"] } } }),
        ]);
        if (batches > 0) {
            const forced = await (await this.getDiscoverWeeklyService()).checkStuckBatches();
            if (forced > 0) logger.debug(`Force-completed ${forced} stuck discovery batch(es)`);
        }
        if (imports > 0) {
            const recovered = await this.checkStuckSpotifyImports();
            if (recovered > 0) logger.debug(`Recovered ${recovered} stuck Spotify import job(s)`);
        }
    }

    /**
     * Check for Spotify import jobs stuck in "scanning" or "downloading" status.
     * Re-triggers scan for jobs stuck scanning, or forces completion check
     * for jobs stuck downloading.
     */
    async checkStuckSpotifyImports(): Promise<number> {
        const SCANNING_RETRY_TIMEOUT = 10 * 60 * 1000; // 10 minutes - retry scan
        const SCANNING_FAIL_TIMEOUT = 30 * 60 * 1000; // 30 minutes - force fail
        const DOWNLOADING_TIMEOUT = 30 * 60 * 1000; // 30 minutes - force completion check

        const stuckJobs = await prisma.spotifyImportJob.findMany({
            where: {
                status: { in: ["scanning", "downloading"] },
            },
        });

        if (stuckJobs.length === 0) return 0;

        let recoveredCount = 0;

        for (const job of stuckJobs) {
            const jobAge = Date.now() - job.updatedAt.getTime();

            if (job.status === "scanning") {
                if (jobAge > SCANNING_FAIL_TIMEOUT) {
                    logger.debug(
                        `[IMPORT STUCK] Job ${job.id} stuck in scanning for ${Math.round(jobAge / 60000)}min - force failing`
                    );

                    await prisma.spotifyImportJob.update({
                        where: { id: job.id },
                        data: {
                            status: "failed",
                            error: "Scan timed out after 30 minutes",
                        },
                    });
                    recoveredCount++;
                } else if (jobAge > SCANNING_RETRY_TIMEOUT) {
                    logger.debug(
                        `[IMPORT STUCK] Job ${job.id} stuck in scanning for ${Math.round(jobAge / 60000)}min - re-queuing scan`
                    );

                    const result = await requestScan({
                        userId: job.userId,
                        source: "spotify-import",
                        spotifyImportJobId: job.id,
                    });
                    if (!result.queued) {
                        logger.debug(`    Scan skipped: ${result.reason}`);
                    }

                    // Touch updatedAt to prevent re-queuing every 30s
                    await prisma.spotifyImportJob.update({
                        where: { id: job.id },
                        data: { progress: job.progress },
                    });
                    recoveredCount++;
                }
            } else if (job.status === "downloading" && jobAge > DOWNLOADING_TIMEOUT) {
                logger.debug(
                    `[IMPORT STUCK] Job ${job.id} stuck in downloading for ${Math.round(jobAge / 60000)}min - forcing completion check`
                );

                try {
                    const spotifyImportService = await this.getSpotifyImportService();
                    await spotifyImportService.checkImportCompletion(job.id);
                    recoveredCount++;
                } catch (err: any) {
                    logger.debug(
                        `[IMPORT STUCK] Failed to force completion check for ${job.id}: ${err.message}`
                    );
                }
            }
        }

        return recoveredCount;
    }

    /**
     * Closes complete jobs Lidarr is not fetching whose album the library already holds:
     * the same album id, or the same artist and title with edition words set aside.
     * Covers albums that arrived some other way and requests for an album already owned.
     */
    async reconcileWithLocalLibrary(): Promise<{ reconciled: number }> {
        // A job Lidarr is fetching is settled by what Lidarr says about its album.
        const wanted = (
            await prisma.downloadJob.findMany({
                where: { status: { in: ["pending", "processing"] }, lidarrAlbumId: null },
            })
        ).filter((job) => {
            const meta = (job.metadata as any) ?? {};
            return job.targetMbid || (meta.artistName && meta.albumTitle);
        });
        if (wanted.length === 0) return { reconciled: 0 };

        const names = [...new Set(wanted.map((job) => (job.metadata as any)?.artistName).filter(Boolean))] as string[];
        // A name with no letters or digits has no identity key; it is matched by its exact name instead, never by "".
        const keys = names.map((n) => artistIdentityKey(n)).filter(Boolean);
        const keyless = names.filter((n) => !artistIdentityKey(n));
        const localAlbums = await prisma.album.findMany({
            where: {
                tracks: { some: {} },
                OR: [
                    { rgMbid: { in: wanted.map((job) => job.targetMbid).filter((m): m is string => !!m) } },
                    { artist: { identityKey: { in: keys } } },
                    ...(keyless.length > 0 ? [{ artist: { name: { in: keyless } } }] : []),
                ],
            },
            select: { rgMbid: true, title: true, artist: { select: { name: true } } },
        });
        const mbids = new Set(localAlbums.map((a) => a.rgMbid));
        const artistKey = (name: string) => artistIdentityKey(name) || `name:${name}`;
        const owned = new Set(localAlbums.map((a) => `${artistKey(a.artist.name)}|${editionlessKey(a.title)}`));

        const found = wanted.filter((job) => {
            const meta = (job.metadata as any) ?? {};
            return (
                (!!job.targetMbid && mbids.has(job.targetMbid)) ||
                (!!meta.artistName && !!meta.albumTitle && owned.has(`${artistKey(meta.artistName)}|${editionlessKey(meta.albumTitle)}`))
            );
        });
        const reconciled = await simpleDownloadManager.completeJobs(found);
        if (reconciled > 0) {
            logger.debug(`[LOCAL-RECONCILE] ${reconciled} job(s) found in the library`);
        }
        return { reconciled };
    }
}

// Export singleton instance
export const queueCleaner = new QueueCleanerService();
