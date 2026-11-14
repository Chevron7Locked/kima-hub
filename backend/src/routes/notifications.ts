import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { notificationService } from "../services/notificationService";
import { requireAcquirePermission } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import type { DownloadJob, Prisma } from "@prisma/client";
import { config } from "../config";
import * as downloadJobs from "../services/downloads/jobs";
import {
    createRetryJob,
    downloadSources,
    failRetryJob,
    findSources,
    NO_SOURCES,
    retryJobTarget,
    soulseekTarget,
} from "../services/pendingTrackRetry";

const router = Router();

/** The start of the stand-in id a retried import job gets when its album has no MusicBrainz id. */
const NO_ALBUM_ID = "retry_";

type RetryOutcome<T> = { running: DownloadJob | null } | { replacement: T };

/**
 * Retries a failed download once. In one transaction the failed job leaves the list (the first retry to clear it wins),
 * and then either the replacement is made or nothing is: `running` is the job already downloading the album, or null
 * when another retry cleared the failed job first and its replacement has since ended. A failed job is cleared
 * whenever its retry exists, so an answer of "already running" leaves no stale entry behind. `make` creates the
 * replacement in the same transaction, so the user sees the failed job or its replacement, never neither.
 */
async function retryOnce<T>(
    failedJob: DownloadJob,
    running: { targetMbid: string } | null,
    make: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<RetryOutcome<T>> {
    return prisma.$transaction(async (tx) => {
        // The claim comes before anything is created: a second retry waits here for the first to commit, then finds the job cleared.
        const claimed = await tx.downloadJob.updateMany({ where: { id: failedJob.id, cleared: false }, data: { cleared: true } });
        const existing = running
            ? await tx.downloadJob.findFirst({
                  where: { userId: failedJob.userId, ...running, status: { in: ["pending", "processing"] }, cleared: { not: true } },
              })
            : null;
        if (claimed.count === 0 || existing) return { running: existing };
        return { replacement: await make(tx) };
    });
}

const deduplicated = (running: DownloadJob | null) => ({ success: true, newJobId: running?.id, deduplicated: true });

/**
 * GET /notifications
 * Get all uncleared notifications for the current user
 */
router.get(
    "/",
    async (req: Request, res: Response) => {
        try {
            logger.debug(
                `[Notifications] Fetching notifications for user ${
                    req.user!.id
                }`
            );
            const notifications = await notificationService.getForUser(
                req.user!.id
            );
            logger.debug(
                `[Notifications] Found ${notifications.length} notifications`
            );
            res.json(notifications);
        } catch (error: any) {
            logger.error("Error fetching notifications:", error);
            res.status(500).json({ error: "Failed to fetch notifications" });
        }
    }
);

/**
 * GET /notifications/unread-count
 * Get count of unread notifications
 */
router.get(
    "/unread-count",
    async (req: Request, res: Response) => {
        try {
            const count = await notificationService.getUnreadCount(
                req.user!.id
            );
            res.json({ count });
        } catch (error: any) {
            logger.error("Error fetching unread count:", error);
            res.status(500).json({ error: "Failed to fetch unread count" });
        }
    }
);

const clientNotificationSchema = z.object({
    type: z.enum(["error", "system"]),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().max(500).optional(),
    href: z.string().regex(/^\/[^/\\]/).max(200).optional(),
});

const CLIENT_ROWS_PER_USER = 50;

/**
 * POST /notifications
 * Record an outcome the browser saw. One row per title, so a repeat replaces it,
 * and only the newest 50 titles are kept.
 */
router.post("/", async (req: Request, res: Response) => {
    const parsed = clientNotificationSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid notification" });
    }
    const { type, title, message, href } = parsed.data;
    try {
        const notification = await notificationService.create({
            userId: req.user!.id,
            type,
            title,
            message,
            metadata: href ? { href } : undefined,
            groupKey: `client:${title}`,
            renotify: true,
        });
        await notificationService.trimGroup(req.user!.id, "client:", CLIENT_ROWS_PER_USER);
        res.status(201).json(notification);
    } catch (error: any) {
        logger.error("Error creating notification:", error);
        res.status(500).json({ error: "Failed to create notification" });
    }
});

/**
 * POST /notifications/:id/read
 * Mark a notification as read
 */
router.post(
    "/:id/read",
    async (req: Request, res: Response) => {
        try {
            await notificationService.markAsRead(req.params.id, req.user!.id);
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error marking notification as read:", error);
            res.status(500).json({
                error: "Failed to mark notification as read",
            });
        }
    }
);

/**
 * POST /notifications/read-all
 * Mark all notifications as read
 */
router.post(
    "/read-all",
    async (req: Request, res: Response) => {
        try {
            await notificationService.markAllAsRead(req.user!.id);
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error marking all notifications as read:", error);
            res.status(500).json({
                error: "Failed to mark all notifications as read",
            });
        }
    }
);

/**
 * POST /notifications/:id/clear
 * Clear (dismiss) a notification
 */
router.post(
    "/:id/clear",
    async (req: Request, res: Response) => {
        try {
            await notificationService.clear(req.params.id, req.user!.id);
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error clearing notification:", error);
            res.status(500).json({ error: "Failed to clear notification" });
        }
    }
);

/**
 * POST /notifications/clear-all
 * Clear all notifications
 */
router.post(
    "/clear-all",
    async (req: Request, res: Response) => {
        try {
            await notificationService.clearAll(req.user!.id);
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error clearing all notifications:", error);
            res.status(500).json({
                error: "Failed to clear all notifications",
            });
        }
    }
);

/**
 * GET /notifications/downloads/history
 * Get completed/failed downloads that haven't been cleared
 * Deduplicated by album subject (shows only most recent entry per album)
 */
router.get(
    "/downloads/history",
    async (req: Request, res: Response) => {
        try {
            const downloads = await prisma.downloadJob.findMany({
                where: {
                    userId: req.user!.id,
                    status: { in: ["completed", "failed", "exhausted"] },
                    cleared: false,
                },
                orderBy: { updatedAt: "desc" },
                take: 100, // Fetch more to account for duplicates
            });

            const seen = new Set<string>();
            const deduplicated = downloads.filter((download) => {
                if (seen.has(download.subject)) {
                    return false; // Skip duplicate
                }
                seen.add(download.subject);
                return true; // Keep first occurrence (most recent due to ordering)
            });

            res.json(deduplicated.slice(0, 50));
        } catch (error: any) {
            logger.error("Error fetching download history:", error);
            res.status(500).json({ error: "Failed to fetch download history" });
        }
    }
);

/**
 * GET /notifications/downloads/active
 * Get active downloads (pending/processing)
 */
router.get(
    "/downloads/active",
    async (req: Request, res: Response) => {
        try {
            const downloads = await prisma.downloadJob.findMany({
                where: {
                    userId: req.user!.id,
                    status: { in: ["pending", "processing"] },
                },
                orderBy: { createdAt: "desc" },
            });
            res.json(downloads);
        } catch (error: any) {
            logger.error("Error fetching active downloads:", error);
            res.status(500).json({ error: "Failed to fetch active downloads" });
        }
    }
);

/**
 * POST /notifications/downloads/:id/clear
 * Clear a download from history
 */
router.post(
    "/downloads/:id/clear",
    async (req: Request, res: Response) => {
        try {
            await prisma.downloadJob.updateMany({
                where: {
                    id: req.params.id,
                    userId: req.user!.id,
                },
                data: { cleared: true },
            });
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error clearing download:", error);
            res.status(500).json({ error: "Failed to clear download" });
        }
    }
);

/**
 * POST /notifications/downloads/clear-all
 * Clear all completed/failed downloads from history
 */
router.post(
    "/downloads/clear-all",
    async (req: Request, res: Response) => {
        try {
            await prisma.downloadJob.updateMany({
                where: {
                    userId: req.user!.id,
                    status: { in: ["completed", "failed", "exhausted"] },
                    cleared: false,
                },
                data: { cleared: true },
            });
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error clearing all downloads:", error);
            res.status(500).json({ error: "Failed to clear all downloads" });
        }
    }
);

/**
 * POST /notifications/downloads/:id/retry
 * Retry a failed download
 */
router.post(
    "/downloads/:id/retry",
    requireAcquirePermission,
    async (req: Request, res: Response) => {
        try {
            const failedJob = await prisma.downloadJob.findFirst({
                where: {
                    id: req.params.id,
                    userId: req.user!.id,
                    status: { in: ["failed", "exhausted"] },
                },
            });

            if (!failedJob) {
                return res
                    .status(404)
                    .json({ error: "Download not found or not failed" });
            }

            // If this was a pending-track retry job, re-run the pending-track retry flow
            const metadata = failedJob.metadata as Record<
                string,
                unknown
            > | null;
            if (metadata?.downloadType === "pending-track-retry") {
                const playlistId = metadata.playlistId as string | undefined;
                const pendingTrackId = metadata.pendingTrackId as
                    | string
                    | undefined;

                if (!playlistId || !pendingTrackId) {
                    return res.status(400).json({
                        error: "Cannot retry: missing playlistId or pendingTrackId",
                    });
                }

                // Checked before the failed row is cleared, so a song that is gone leaves its row to be dismissed.
                const pendingTrack = await prisma.playlistPendingTrack.findFirst({
                    where: { id: pendingTrackId, playlistId, playlist: { userId: req.user!.id } },
                });
                if (!pendingTrack) {
                    return res.status(404).json({ error: "Pending track not found" });
                }

                const target = await soulseekTarget();
                const outcome = await retryOnce(failedJob, { targetMbid: retryJobTarget(pendingTrack) }, (tx) =>
                    createRetryJob(req.user!.id, pendingTrack, {}, tx)
                );
                if ("running" in outcome) return res.json(deduplicated(outcome.running));
                const job = outcome.replacement;
                if ("problem" in target) {
                    await failRetryJob(job.id, target.problem);
                    return res.json({ success: false, newJobId: job.id, error: target.problem });
                }

                let matches: Awaited<ReturnType<typeof findSources>>;
                try {
                    matches = await findSources(job, pendingTrack);
                } catch (error: any) {
                    // findSources has already failed the job: the user sees it and can retry again.
                    logger.error(`[Retry] Soulseek search for job ${job.id} failed:`, error);
                    return res.json({ success: false, newJobId: job.id, error: error?.message || "Soulseek search failed" });
                }
                if (matches.length === 0) {
                    return res.json({ success: false, newJobId: job.id, error: NO_SOURCES });
                }

                void downloadSources(job, pendingTrack, matches, target.musicPath, "retry-pending-track");
                return res.json({ success: true, newJobId: job.id });
            }

            // If this was a spotify_import job, retry with Soulseek first
            if (metadata?.downloadType === "spotify_import") {
                const artistName = metadata.artistName as string;
                const albumTitle = metadata.albumTitle as string;

                if (!artistName || !albumTitle) {
                    return res.status(400).json({
                        error: "Cannot retry: missing artist/album info",
                    });
                }

                // A placeholder id is no album: nothing running can share it.
                const hasAlbumId = !!failedJob.targetMbid && !failedJob.targetMbid.startsWith(NO_ALBUM_ID);
                const outcome = await retryOnce(failedJob, hasAlbumId ? { targetMbid: failedJob.targetMbid! } : null, (tx) =>
                    downloadJobs.create({
                        userId: req.user!.id,
                        type: "album",
                        targetMbid: failedJob.targetMbid || `${NO_ALBUM_ID}${Date.now()}`,
                        artistMbid: failedJob.artistMbid,
                        subject: `${artistName} - ${albumTitle}`,
                        status: "processing",
                        metadata: {
                            ...downloadJobs.withoutFailureMarks(metadata),
                            retryAttempt: true,
                        } as any,
                    }, tx)
                );
                if ("running" in outcome) return res.json(deduplicated(outcome.running));
                const newJobRecord = outcome.replacement;

                try {
                    // Try Soulseek first (async)
                    const { soulseekService } = await import(
                        "../services/soulseek"
                    );
                    const { getSystemSettings } = await import(
                        "../utils/systemSettings"
                    );

                    const settings = await getSystemSettings();
                    const musicPath = config.music.musicPath;

                    // Build track from album info (single track search using album as title)
                    const tracks = [
                        {
                            artist: artistName,
                            title: albumTitle,
                            album: albumTitle,
                        },
                    ];

                    logger.debug(
                        `[Retry] Trying Soulseek for ${artistName} - ${albumTitle}`
                    );

                    // Run Soulseek search async
                    soulseekService
                        .searchAndDownloadBatch(tracks, musicPath, settings?.soulseekConcurrentDownloads ?? 4)
                        .then(async (result) => {
                            if (result.successful > 0) {
                                await downloadJobs.complete([newJobRecord], {
                                    source: "soulseek",
                                    tracksDownloaded: result.successful,
                                    files: result.files,
                                });
                                logger.debug(
                                    `[Retry] ✓ Soulseek downloaded ${result.successful} tracks for ${artistName} - ${albumTitle}`
                                );

                                // Trigger library scan (full walk — the
                                // download folder is not recorded, so there is
                                // nothing narrower to scan)
                                const { requestScan } = await import(
                                    "../workers/scanRequest"
                                );
                                await requestScan({
                                    userId: req.user!.id,
                                    source: "retry-spotify-import",
                                });
                            } else {
                                // Soulseek failed, try Lidarr if we have an MBID
                                logger.debug(
                                    `[Retry] Soulseek failed, trying Lidarr for ${artistName} - ${albumTitle}`
                                );

                                if (
                                    failedJob.targetMbid &&
                                    !failedJob.targetMbid.startsWith(NO_ALBUM_ID)
                                ) {
                                    const { simpleDownloadManager } = await import(
                                        "../services/simpleDownloadManager"
                                    );
                                    const lidarrResult =
                                        await simpleDownloadManager.startDownload(
                                            newJobRecord.id,
                                            artistName,
                                            albumTitle,
                                            failedJob.targetMbid,
                                            false
                                        );

                                    if (!lidarrResult.success) {
                                        await downloadJobs.fail(
                                            [newJobRecord],
                                            lidarrResult.error || "Both Soulseek and Lidarr failed"
                                        );
                                    }
                                } else {
                                    await downloadJobs.fail(
                                        [newJobRecord],
                                        "No tracks found on Soulseek, no MBID for Lidarr fallback"
                                    );
                                }
                            }
                        })
                        .catch(async (error) => {
                            logger.error(`[Retry] Soulseek error:`, error);
                            await downloadJobs.fail(
                                [newJobRecord],
                                error?.message || "Soulseek error"
                            ).catch((failError) => logger.error(`[Retry] Could not fail job ${newJobRecord.id}:`, failError));
                        });

                    return res.json({ success: true, newJobId: newJobRecord.id });
                } catch (error: any) {
                    // The replacement could not start: it fails, so the user sees it and can retry again.
                    logger.error(`[Retry] Could not start job ${newJobRecord.id}:`, error);
                    const message = error?.message || "Retry could not start";
                    await downloadJobs.fail([newJobRecord], message).catch((failError) => logger.error(`[Retry] Could not fail job ${newJobRecord.id}:`, failError));
                    return res.json({ success: false, newJobId: newJobRecord.id, error: message });
                }
            }

            const targetMbid = failedJob.targetMbid;
            if (!targetMbid) {
                return res
                    .status(400)
                    .json({ error: "Cannot retry: missing album MBID" });
            }

            // The job's own record names the artist; a job from before that was recorded has only its "Artist - Album" subject.
            const subjectParts = failedJob.subject.split(" - ");
            const artistName = (metadata?.artistName as string) || subjectParts[0] || failedJob.subject;
            const albumTitle =
                (metadata?.albumTitle as string) ||
                subjectParts[1] ||
                failedJob.subject;

            const outcome = await retryOnce(failedJob, { targetMbid }, (tx) =>
                downloadJobs.create({
                    userId: req.user!.id,
                    type: failedJob.type,
                    targetMbid,
                    artistMbid: failedJob.artistMbid,
                    subject: failedJob.subject,
                    metadata: downloadJobs.withoutFailureMarks(metadata) as any,
                }, tx)
            );
            if ("running" in outcome) return res.json(deduplicated(outcome.running));
            const newJobRecord = outcome.replacement;

            let result: { success: boolean; error?: string };
            try {
                const { simpleDownloadManager } = await import(
                    "../services/simpleDownloadManager"
                );

                result = await simpleDownloadManager.startDownload(
                    newJobRecord.id,
                    artistName,
                    albumTitle,
                    targetMbid,
                    false // isDiscovery
                );
            } catch (error: any) {
                // The replacement could not start: it fails, so the user sees it and can retry again.
                logger.error(`[Retry] Could not start job ${newJobRecord.id}:`, error);
                result = { success: false, error: error?.message || "Retry could not start" };
                await downloadJobs.fail([newJobRecord], result.error!).catch((failError) => logger.error(`[Retry] Could not fail job ${newJobRecord.id}:`, failError));
            }

            res.json({
                success: result.success,
                newJobId: newJobRecord.id,
                error: result.error,
            });
        } catch (error: any) {
            logger.error("Error retrying download:", error);
            res.status(500).json({ error: "Failed to retry download" });
        }
    }
);

export default router;
