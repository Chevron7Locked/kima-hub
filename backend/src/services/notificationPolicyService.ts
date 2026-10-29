/**
 * Download-job notifications: one per album, when the download completes or
 * fails for good. Discover and playlist-import jobs report as a batch instead.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { nameKey } from "./nameFold";

/** A download's artist or album name as compared for duplicates: nameKey, or its plain text when that has no letters. */
const duplicateKey = (name: unknown) =>
    typeof name === "string" ? nameKey(name) || name.toLowerCase().trim() : "";

interface NotificationDecision {
    shouldNotify: boolean;
    reason: string;
    notificationType?: "download_complete" | "download_failed";
}

const DEFAULT_RETRY_WINDOW_MINUTES = 30;
// How many of the user's recent terminal jobs are checked for an earlier
// notification of the same album. Retries land close in time, so a bounded
// recent window suffices; a miss costs one extra notification.
const DUPLICATE_CHECK_WINDOW = 100;

class NotificationPolicyService {
    /**
     * Evaluate whether a notification should be sent for a download job.
     *
     * @param jobId - The download job ID
     * @param eventType - The type of event (complete, failed, retry)
     * @returns Decision on whether to send notification
     */
    async evaluateNotification(
        jobId: string,
        eventType: "complete" | "failed" | "retry"
    ): Promise<NotificationDecision> {
        logger.debug(
            `[NOTIFICATION-POLICY] Evaluating: ${jobId} (${eventType})`
        );

        // Fetch job with current state
        const job = await prisma.downloadJob.findUnique({
            where: { id: jobId },
        });

        if (!job) {
            return {
                shouldNotify: false,
                reason: "Job not found",
            };
        }

        const metadata = (job.metadata as any) || {};
        const downloadType = metadata.downloadType || "library";

        // Discovery and Spotify Import jobs never send individual notifications
        // (they send batch notifications instead)
        if (downloadType === "discovery" || metadata.spotifyImportJobId) {
            return {
                shouldNotify: false,
                reason: `${downloadType} download - batch notification only`,
            };
        }

        // Check if notification already sent for this job
        if (metadata.notificationSent === true) {
            return {
                shouldNotify: false,
                reason: "Notification already sent for this job",
            };
        }

        // Handle based on job status
        switch (job.status) {
            case "completed":
                return await this.evaluateTerminalJob(job, eventType, "complete", {
                    reason: "Download completed successfully",
                    notificationType: "download_complete",
                });

            case "processing":
                return await this.evaluateProcessingJob(job, eventType);

            case "failed":
            case "exhausted":
                return await this.evaluateTerminalJob(job, eventType, "failed", {
                    reason: "Download failed",
                    notificationType: "download_failed",
                });

            case "pending":
                return {
                    shouldNotify: false,
                    reason: "Job not started yet",
                };

            default:
                return {
                    shouldNotify: false,
                    reason: `Unknown status: ${job.status}`,
                };
        }
    }

    /**
     * A job that reached a terminal state notifies once — unless another job
     * for the same album already did.
     */
    private async evaluateTerminalJob(
        job: any,
        eventType: string,
        wantedEvent: "complete" | "failed",
        notification: {
            reason: string;
            notificationType: "download_complete" | "download_failed";
        }
    ): Promise<NotificationDecision> {
        if (eventType !== wantedEvent) {
            return {
                shouldNotify: false,
                reason: `Invalid event type for ${job.status} job`,
            };
        }

        // Check if another job for same album already notified
        const hasOtherNotification = await this.hasAlreadyNotified(job);
        if (hasOtherNotification) {
            return {
                shouldNotify: false,
                reason: "Another job for same album already sent notification",
            };
        }

        return {
            shouldNotify: true,
            ...notification,
        };
    }

    /**
     * Evaluate notification for processing job
     */
    private async evaluateProcessingJob(
        job: any,
        eventType: string
    ): Promise<NotificationDecision> {
        // Processing jobs should never send notifications
        // They're still in active retry window
        if (eventType === "complete") {
            return {
                shouldNotify: false,
                reason: "Job still processing - wait for status update to completed",
            };
        }

        if (eventType === "failed" || eventType === "retry") {
            // Check if in retry window
            const inRetryWindow = await this.isInRetryWindow(job);
            if (inRetryWindow) {
                return {
                    shouldNotify: false,
                    reason: "Job in active retry window - suppressing notification",
                };
            }
            // Retry window expired but still processing: stay quiet until the
            // job reaches a terminal status and reports through it.
            return {
                shouldNotify: false,
                reason: "Retry window expired but job still processing - waiting for terminal status",
            };
        }

        return {
            shouldNotify: false,
            reason: "Processing job - no notification needed",
        };
    }

    /**
     * True while a processing job is young enough that a retry may still
     * succeed: it started (or was created) within the retry window.
     */
    private async isInRetryWindow(job: any): Promise<boolean> {
        if (job.status !== "processing") {
            return false;
        }

        const metadata = (job.metadata as any) || {};
        const startedAt = metadata.startedAt
            ? new Date(metadata.startedAt)
            : job.createdAt;

        const windowMs = DEFAULT_RETRY_WINDOW_MINUTES * 60 * 1000;
        const elapsed = Date.now() - startedAt.getTime();

        if (elapsed > windowMs) {
            logger.debug(
                `[NOTIFICATION-POLICY]   Retry window expired (${Math.round(
                    elapsed / 60000
                )}m > ${DEFAULT_RETRY_WINDOW_MINUTES}m)`
            );
            return false;
        }

        logger.debug(
            `[NOTIFICATION-POLICY]   In retry window (${Math.round(
                elapsed / 60000
            )}m < ${DEFAULT_RETRY_WINDOW_MINUTES}m)`
        );
        return true;
    }

    /**
     * Check if another job for the same artist+album has already sent a notification
     * Prevents duplicate notifications when multiple jobs exist for same album
     */
    private async hasAlreadyNotified(job: any): Promise<boolean> {
        const metadata = (job.metadata as any) || {};
        const artistName = duplicateKey(metadata?.artistName);
        const albumTitle = duplicateKey(metadata?.albumTitle);

        if (!artistName || !albumTitle) {
            return false;
        }

        // Recent terminal jobs, matched on artist+album in their JSON metadata (Prisma
        // cannot filter JSON portably). completedAt can be null and Postgres sorts
        // NULLS FIRST on DESC, so `nulls: "last"` keeps them from filling the window.
        const otherJobs = await prisma.downloadJob.findMany({
            where: {
                id: { not: job.id },
                userId: job.userId,
                status: { in: ["completed", "failed", "exhausted"] },
            },
            select: { id: true, metadata: true },
            orderBy: { completedAt: { sort: "desc", nulls: "last" } },
            take: DUPLICATE_CHECK_WINDOW,
        });

        for (const otherJob of otherJobs) {
            const otherMeta = (otherJob.metadata as any) || {};
            const otherArtist = duplicateKey(otherMeta?.artistName);
            const otherAlbum = duplicateKey(otherMeta?.albumTitle);

            if (
                otherArtist === artistName &&
                otherAlbum === albumTitle &&
                otherMeta?.notificationSent === true
            ) {
                logger.debug(
                    `[NOTIFICATION-POLICY]   Found duplicate notification in job ${otherJob.id}`
                );
                return true;
            }
        }

        return false;
    }
}

// Singleton instance
export const notificationPolicyService = new NotificationPolicyService();
