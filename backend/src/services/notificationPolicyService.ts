/**
 * Notification Policy Service
 *
 * Intelligent notification filtering for download jobs.
 * Suppresses intermediate failures during active retry cycles,
 * only sending notifications for terminal states (completed/exhausted).
 *
 * State Machine: PENDING → PROCESSING → COMPLETED/EXHAUSTED
 *
 * Policy:
 * - SUPPRESS: All failures during active retry window
 * - SEND: Final success, permanent failure after retries exhausted
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";

interface NotificationDecision {
    shouldNotify: boolean;
    reason: string;
    notificationType?: "download_complete" | "download_failed";
}

// Configuration constants
const DEFAULT_RETRY_WINDOW_MINUTES = 30;
const SUPPRESS_TRANSIENT_FAILURES = true;

// Failure classification patterns
const TRANSIENT_PATTERNS = [
    "no sources found",
    "no indexer results",
    "no releases available",
    "import failed",
    "connection timeout",
    "rate limited",
    "temporarily unavailable",
    "searching for alternative",
    "download stuck",
];

const PERMANENT_PATTERNS = [
    "all releases exhausted",
    "all albums exhausted",
    "artist not found",
    "download cancelled",
    "album not found in lidarr",
];

const CRITICAL_PATTERNS = [
    "disk full",
    "permission denied",
    "lidarr unavailable",
    "authentication failed",
    "invalid api key",
];

type FailureClassification = "transient" | "permanent" | "critical";

class NotificationPolicyService {
    /**
     * Evaluate whether a notification should be sent for a download job.
     *
     * @param jobId - The download job ID
     * @param eventType - The type of event (complete, failed, retry, timeout)
     * @returns Decision on whether to send notification
     */
    async evaluateNotification(
        jobId: string,
        eventType: "complete" | "failed" | "retry" | "timeout"
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
                return await this.evaluateCompletedJob(job, eventType);

            case "processing":
                return await this.evaluateProcessingJob(job, eventType);

            case "failed":
            case "exhausted":
                return await this.evaluateFailedJob(job, eventType);

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
     * Evaluate notification for completed job
     */
    private async evaluateCompletedJob(
        job: any,
        eventType: string
    ): Promise<NotificationDecision> {
        if (eventType !== "complete") {
            return {
                shouldNotify: false,
                reason: "Invalid event type for completed job",
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
            reason: "Download completed successfully",
            notificationType: "download_complete",
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
            // Retry window expired but still processing - extend it
            return {
                shouldNotify: false,
                reason: "Retry window expired but job still processing - extending timeout",
            };
        }

        if (eventType === "timeout") {
            const inRetryWindow = await this.isInRetryWindow(job);
            if (inRetryWindow) {
                return {
                    shouldNotify: false,
                    reason: "Still in retry window - extending timeout",
                };
            }
            // Timeout expired and out of retry window - let caller handle failure
            return {
                shouldNotify: false,
                reason: "Timeout expired - caller should mark as failed",
            };
        }

        return {
            shouldNotify: false,
            reason: "Processing job - no notification needed",
        };
    }

    /**
     * Evaluate notification for failed/exhausted job
     */
    private async evaluateFailedJob(
        job: any,
        eventType: string
    ): Promise<NotificationDecision> {
        if (eventType !== "failed" && eventType !== "timeout") {
            return {
                shouldNotify: false,
                reason: "Invalid event type for failed job",
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

        // Classify the failure
        const classification = this.classifyFailure(
            job,
            job.error || "Unknown error"
        );

        // Critical errors always notify
        if (classification === "critical") {
            return {
                shouldNotify: true,
                reason: "Critical error requires user intervention",
                notificationType: "download_failed",
            };
        }

        // Transient failures - suppress if configured
        if (classification === "transient" && SUPPRESS_TRANSIENT_FAILURES) {
            return {
                shouldNotify: false,
                reason: "Transient failure - suppressed (may succeed on retry)",
            };
        }

        // Permanent failures or transient with suppress disabled
        return {
            shouldNotify: true,
            reason:
                classification === "permanent"
                    ? "Permanent failure after retries exhausted"
                    : "Failure notification (transient suppression disabled)",
            notificationType: "download_failed",
        };
    }

    /**
     * Check if job is in active retry window
     * A job is in retry window if:
     * 1. Status is 'processing'
     * 2. Started within the last RETRY_WINDOW_MINUTES
     */
    private async isInRetryWindow(job: any): Promise<boolean> {
        if (job.status !== "processing") {
            return false;
        }

        const metadata = (job.metadata as any) || {};

        // Get retry window duration (configurable per job or use default)
        const retryWindowMinutes =
            metadata.retryWindowMinutes || DEFAULT_RETRY_WINDOW_MINUTES;

        // Get start time
        const startedAt = metadata.startedAt
            ? new Date(metadata.startedAt)
            : job.createdAt;

        // Calculate if window has expired
        const windowMs = retryWindowMinutes * 60 * 1000;
        const elapsed = Date.now() - startedAt.getTime();

        if (elapsed > windowMs) {
            logger.debug(
                `[NOTIFICATION-POLICY]   Retry window expired (${Math.round(
                    elapsed / 60000
                )}m > ${retryWindowMinutes}m)`
            );
            return false;
        }

        logger.debug(
            `[NOTIFICATION-POLICY]   In retry window (${Math.round(
                elapsed / 60000
            )}m < ${retryWindowMinutes}m)`
        );
        return true;
    }

    /**
     * Check if another job for the same artist+album has already sent a notification
     * Prevents duplicate notifications when multiple jobs exist for same album
     */
    private async hasAlreadyNotified(job: any): Promise<boolean> {
        const metadata = (job.metadata as any) || {};
        const artistName = metadata?.artistName?.toLowerCase().trim() || "";
        const albumTitle = metadata?.albumTitle?.toLowerCase().trim() || "";

        if (!artistName || !albumTitle) {
            return false;
        }

        // Find other jobs for same album that have notified
        const otherNotifiedJob = await prisma.downloadJob.findFirst({
            where: {
                id: { not: job.id },
                userId: job.userId,
                status: { in: ["completed", "failed", "exhausted"] },
            },
        });

        if (otherNotifiedJob) {
            const otherMeta = (otherNotifiedJob.metadata as any) || {};
            const otherArtist =
                otherMeta?.artistName?.toLowerCase().trim() || "";
            const otherAlbum =
                otherMeta?.albumTitle?.toLowerCase().trim() || "";

            // Check if same album and notification was sent
            if (
                otherArtist === artistName &&
                otherAlbum === albumTitle &&
                otherMeta?.notificationSent === true
            ) {
                logger.debug(
                    `[NOTIFICATION-POLICY]   Found duplicate notification in job ${otherNotifiedJob.id}`
                );
                return true;
            }
        }

        return false;
    }

    /**
     * Classify failure type based on error message
     * @returns 'transient' | 'permanent' | 'critical'
     */
    private classifyFailure(job: any, error: string): FailureClassification {
        const errorLower = error.toLowerCase();

        // Check critical patterns first
        for (const pattern of CRITICAL_PATTERNS) {
            if (errorLower.includes(pattern)) {
                logger.debug(
                    `[NOTIFICATION-POLICY]   Classified as CRITICAL: ${pattern}`
                );
                return "critical";
            }
        }

        // Check permanent patterns
        for (const pattern of PERMANENT_PATTERNS) {
            if (errorLower.includes(pattern)) {
                logger.debug(
                    `[NOTIFICATION-POLICY]   Classified as PERMANENT: ${pattern}`
                );
                return "permanent";
            }
        }

        // Check transient patterns
        for (const pattern of TRANSIENT_PATTERNS) {
            if (errorLower.includes(pattern)) {
                logger.debug(
                    `[NOTIFICATION-POLICY]   Classified as TRANSIENT: ${pattern}`
                );
                return "transient";
            }
        }

        // Default to transient if unknown
        logger.debug(
            `[NOTIFICATION-POLICY]   Classified as TRANSIENT (default)`
        );
        return "transient";
    }

    /**
     * Get configuration for notification policy
     * Can be extended to pull from user settings or system config
     */
    getConfig(): {
        retryWindowMinutes: number;
        suppressTransientFailures: boolean;
    } {
        return {
            retryWindowMinutes: DEFAULT_RETRY_WINDOW_MINUTES,
            suppressTransientFailures: SUPPRESS_TRANSIENT_FAILURES,
        };
    }
}

// Singleton instance
export const notificationPolicyService = new NotificationPolicyService();
