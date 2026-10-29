import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { notificationService } from "../services/notificationService";
import { requireAuth, requireAcquirePermission } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
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

/**
 * GET /notifications
 * Get all uncleared notifications for the current user
 */
router.get(
    "/",
    requireAuth,
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
    requireAuth,
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
router.post("/", requireAuth, async (req: Request, res: Response) => {
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
    requireAuth,
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
    requireAuth,
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
    requireAuth,
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
    requireAuth,
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
    requireAuth,
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
    requireAuth,
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
    requireAuth,
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
    requireAuth,
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
    requireAuth,
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
                await prisma.downloadJob.update({
                    where: { id: failedJob.id },
                    data: { cleared: true },
                });

                const existingActiveJob = await prisma.downloadJob.findFirst({
                    where: {
                        userId: req.user!.id,
                        targetMbid: retryJobTarget(pendingTrack),
                        status: { in: ["pending", "processing"] },
                        cleared: { not: true },
                    },
                });
                if (existingActiveJob) {
                    return res.json({
                        success: true,
                        newJobId: existingActiveJob.id,
                        deduplicated: true,
                    });
                }

                const job = await createRetryJob(req.user!.id, pendingTrack);
                if ("problem" in target) {
                    await failRetryJob(job.id, target.problem);
                    return res.json({ success: false, newJobId: job.id, error: target.problem });
                }

                const matches = await findSources(job, pendingTrack);
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

                // Dedup: check for existing active download job (skip for synthetic retry_ MBIDs)
                if (failedJob.targetMbid && !failedJob.targetMbid.startsWith('retry_')) {
                    const existingActiveJob = await prisma.downloadJob.findFirst({
                        where: {
                            userId: req.user!.id,
                            targetMbid: failedJob.targetMbid,
                            status: { in: ["pending", "processing"] },
                            cleared: { not: true },
                        },
                    });

                    if (existingActiveJob) {
                        return res.json({
                            success: true,
                            newJobId: existingActiveJob.id,
                            deduplicated: true,
                        });
                    }
                }

                await prisma.downloadJob.update({
                    where: { id: failedJob.id },
                    data: { cleared: true },
                });

                const newJobRecord = await prisma.downloadJob.create({
                    data: {
                        userId: req.user!.id,
                        type: "album",
                        targetMbid:
                            failedJob.targetMbid || `retry_${Date.now()}`,
                        artistMbid: failedJob.artistMbid,
                        subject: `${artistName} - ${albumTitle}`,
                        status: "processing",
                        attempts: 1,
                        startedAt: new Date(),
                        metadata: {
                            ...metadata,
                            retryAttempt: true,
                        },
                    },
                });

                // Try Soulseek first (async)
                const { soulseekService } = await import(
                    "../services/soulseek"
                );
                const { getSystemSettings } = await import(
                    "../utils/systemSettings"
                );

                const settings = await getSystemSettings();
                const musicPath = settings?.musicPath;

                if (!musicPath) {
                    await prisma.downloadJob.update({
                        where: { id: newJobRecord.id },
                        data: {
                            status: "failed",
                            error: "Music path not configured",
                            completedAt: new Date(),
                        },
                    });
                    return res.json({
                        success: false,
                        newJobId: newJobRecord.id,
                        error: "Music path not configured",
                    });
                }

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
                            await prisma.downloadJob.update({
                                where: { id: newJobRecord.id },
                                data: {
                                    status: "completed",
                                    completedAt: new Date(),
                                    error: null,
                                    metadata: {
                                        ...metadata,
                                        source: "soulseek",
                                        tracksDownloaded: result.successful,
                                        files: result.files,
                                    },
                                },
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
                                !failedJob.targetMbid.startsWith("retry_")
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
                                    await prisma.downloadJob.update({
                                        where: { id: newJobRecord.id },
                                        data: {
                                            status: "failed",
                                            error:
                                                lidarrResult.error ||
                                                "Both Soulseek and Lidarr failed",
                                            completedAt: new Date(),
                                        },
                                    });
                                }
                            } else {
                                await prisma.downloadJob.update({
                                    where: { id: newJobRecord.id },
                                    data: {
                                        status: "failed",
                                        error: "No tracks found on Soulseek, no MBID for Lidarr fallback",
                                        completedAt: new Date(),
                                    },
                                });
                            }
                        }
                    })
                    .catch(async (error) => {
                        logger.error(`[Retry] Soulseek error:`, error);
                        await prisma.downloadJob.update({
                            where: { id: newJobRecord.id },
                            data: {
                                status: "failed",
                                error: error?.message || "Soulseek error",
                                completedAt: new Date(),
                            },
                        });
                    });

                return res.json({ success: true, newJobId: newJobRecord.id });
            }

            if (!failedJob.targetMbid) {
                return res
                    .status(400)
                    .json({ error: "Cannot retry: missing album MBID" });
            }

            // Dedup: check for existing active download job
            const existingActiveJob = await prisma.downloadJob.findFirst({
                where: {
                    userId: req.user!.id,
                    targetMbid: failedJob.targetMbid,
                    status: { in: ["pending", "processing"] },
                    cleared: { not: true },
                },
            });

            if (existingActiveJob) {
                return res.json({
                    success: true,
                    newJobId: existingActiveJob.id,
                    deduplicated: true,
                });
            }

            await prisma.downloadJob.update({
                where: { id: failedJob.id },
                data: { cleared: true },
            });

            // Subject is typically "Artist - Album" format
            const subjectParts = failedJob.subject.split(" - ");
            const artistName = subjectParts[0] || failedJob.subject;
            const albumTitle =
                (metadata?.albumTitle as string) ||
                subjectParts[1] ||
                failedJob.subject;

            const newJobRecord = await prisma.downloadJob.create({
                data: {
                    userId: req.user!.id,
                    type: failedJob.type as "artist" | "album",
                    targetMbid: failedJob.targetMbid,
                    artistMbid: failedJob.artistMbid,
                    subject: failedJob.subject,
                    status: "pending",
                    metadata: (metadata || {}) as any,
                },
            });

            const { simpleDownloadManager } = await import(
                "../services/simpleDownloadManager"
            );

            const result = await simpleDownloadManager.startDownload(
                newJobRecord.id,
                artistName,
                albumTitle,
                failedJob.targetMbid,
                false // isDiscovery
            );

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
