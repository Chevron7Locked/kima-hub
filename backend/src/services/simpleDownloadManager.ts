/**
 * Simple Download Manager (Refactored)
 *
 * Stateless download service that uses the database as the single source of truth.
 * Handles album downloads with automatic retry, blocklisting, and completion tracking.
 * No in-memory state - survives server restarts.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { Prisma, PrismaClient } from "@prisma/client";
import { lidarrService, LidarrRelease, AcquisitionError, AcquisitionErrorType } from "./lidarr";
import { musicBrainzService } from "./musicbrainz";
import { getSystemSettings } from "../utils/systemSettings";
import { notificationService } from "./notificationService";
import { notificationPolicyService } from "./notificationPolicyService";
import { sessionLog } from "../utils/playlistLogger";
import axios from "axios";
import * as crypto from "crypto";

// Type for transactional prisma client
type TransactionClient = Omit<
    PrismaClient,
    "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

// Generate a UUID v4 without external dependency
function generateCorrelationId(): string {
    return crypto.randomUUID();
}

class SimpleDownloadManager {
    private readonly DEFAULT_MAX_ATTEMPTS = 3;
    // Reduced timeouts for faster failure detection
    private readonly IMPORT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes for imports
    private readonly PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for pending
    private readonly NO_SOURCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for no sources found

    /**
     * Get max retry attempts from user's discover config, fallback to default
     */
    private async getMaxAttempts(userId: string): Promise<number> {
        try {
            const config = await prisma.userDiscoverConfig.findUnique({
                where: { userId },
            });
            return config?.maxRetryAttempts || this.DEFAULT_MAX_ATTEMPTS;
        } catch {
            return this.DEFAULT_MAX_ATTEMPTS;
        }
    }

    /**
     * Transaction wrapper with retry logic for serialization conflicts
     */
    private async withTransaction<T>(
        operation: (tx: TransactionClient) => Promise<T>,
        options?: { maxRetries?: number; logPrefix?: string }
    ): Promise<T> {
        const maxRetries = options?.maxRetries ?? 3;
        const logPrefix = options?.logPrefix ?? "[TX]";
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await prisma.$transaction(operation, {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                    maxWait: 5000,
                    timeout: 10000,
                });
            } catch (error: any) {
                // Check for serialization failure
                const isSerializationError =
                    error.code === "P2034" ||
                    error.message?.includes("could not serialize") ||
                    error.message?.includes("deadlock");

                if (isSerializationError && attempt < maxRetries) {
                    lastError = error;
                    const delay = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms
                    logger.debug(
                        `${logPrefix} Serialization conflict, retry ${attempt}/${maxRetries} after ${delay}ms`
                    );
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }
                throw error;
            }
        }

        throw lastError;
    }

    /**
     * Start a new download
     * Returns the correlation ID for webhook matching
     * @param isDiscovery - If true, tags the artist in Lidarr for discovery cleanup
     */
    async startDownload(
        jobId: string,
        artistName: string,
        albumTitle: string,
        albumMbid: string,
        userId: string,
        isDiscovery: boolean = false
    ): Promise<{ success: boolean; correlationId?: string; error?: string; errorType?: AcquisitionErrorType; isRecoverable?: boolean }> {
        logger.debug(
            `\n Starting download: ${artistName} - ${albumTitle}${
                isDiscovery ? " (discovery)" : ""
            }`
        );
        logger.debug(`   Job ID: ${jobId}`);
        logger.debug(`   Album MBID: ${albumMbid}`);

        // Generate correlation ID for webhook matching
        const correlationId = generateCorrelationId();

        try {
            // Fetch artist MBID from MusicBrainz using the album MBID
            let artistMbid: string | undefined;
            try {
                logger.debug(`   Fetching artist MBID from MusicBrainz...`);
                const releaseGroup = await musicBrainzService.getReleaseGroup(
                    albumMbid
                );

                if (releaseGroup?.["artist-credit"]?.[0]?.artist?.id) {
                    artistMbid = releaseGroup["artist-credit"][0].artist.id;
                    logger.debug(`   Found artist MBID: ${artistMbid}`);
                } else {
                    logger.warn(
                        `   Could not extract artist MBID from release group`
                    );
                }
            } catch (mbError) {
                logger.error(
                    `   Failed to fetch artist MBID from MusicBrainz:`,
                    mbError
                );
            }

            // Add album to Lidarr (with discovery tag if this is a discovery download)
            const result = await lidarrService.addAlbum(
                albumMbid,
                artistName,
                albumTitle,
                "/music",
                artistMbid,
                isDiscovery
            );

            if (!result) {
                throw new Error(
                    "Failed to add album to Lidarr - album not found"
                );
            }

            logger.debug(`   Album queued in Lidarr (ID: ${result.id})`);

            // Lidarr may have matched by name and returned a different MBID
            const actualLidarrMbid = result.foreignAlbumId;
            if (actualLidarrMbid && actualLidarrMbid !== albumMbid) {
                logger.debug(
                    `   MBID mismatch - original: ${albumMbid}, Lidarr: ${actualLidarrMbid}`
                );
            }

            // Update job with all tracking information
            // IMPORTANT: Preserve existing metadata (especially tier/similarity from discovery jobs)
            const now = new Date();
            const existingJob = await prisma.downloadJob.findUnique({
                where: { id: jobId },
                select: { metadata: true },
            });
            const existingMetadata = (existingJob?.metadata as any) || {};
            // Initialize status tracking for Lidarr download
            const lidarrAttempts = (existingMetadata.lidarrAttempts || 0) + 1;
            const statusText = `Lidarr #${lidarrAttempts}`;

            await prisma.downloadJob.update({
                where: { id: jobId },
                data: {
                    correlationId, // Unique ID for webhook matching
                    status: "processing",
                    startedAt: now, // For timeout tracking (if field exists)
                    lidarrAlbumId: result.id, // Store Lidarr album ID for retry/cleanup
                    artistMbid: artistMbid, // Store artist MBID for same-artist fallback
                    attempts: 1,
                    metadata: {
                        ...existingMetadata, // Preserve tier, similarity, etc.
                        albumTitle,
                        artistName,
                        artistMbid,
                        albumMbid, // Original requested MBID
                        lidarrMbid: actualLidarrMbid, // Actual Lidarr MBID (may differ)
                        downloadType:
                            existingMetadata.downloadType || "library",
                        startedAt: now.toISOString(), // Backup in metadata for timeout tracking
                        currentSource: "lidarr" as const,
                        lidarrAttempts,
                        statusText,
                    },
                },
            });

            logger.debug(
                `   Download started with correlation ID: ${correlationId}`
            );
            return { success: true, correlationId };
        } catch (error: any) {
            logger.error(`   Failed to start download:`, error.message);

            // Extract error properties if this is an AcquisitionError
            const errorType = error instanceof AcquisitionError ? error.type : undefined;
            const isRecoverable = error instanceof AcquisitionError ? error.isRecoverable : undefined;

            // Get the job to check if it's a discovery job
            const job = await prisma.downloadJob.findUnique({
                where: { id: jobId },
            });
            const existingMetadata = (job?.metadata as any) || {};

            // Handle "No releases available" error - immediate failure
            if (error.message?.includes("No releases available")) {
                logger.debug(`   No sources found - handling immediate failure`);

                // For discovery jobs, skip same-artist fallback
                if (job?.discoveryBatchId) {
                    logger.debug(
                        `   Discovery job - skipping same-artist fallback (diversity enforced)`
                    );
                } else if (job && !job.discoveryBatchId) {
                    // For library downloads, try same-artist fallback
                    logger.debug(
                        `   Library download - trying same-artist fallback...`
                    );

                    const artistMbid =
                        job.artistMbid || existingMetadata.artistMbid;

                    if (artistMbid) {
                        const fallbackResult =
                            await this.tryNextAlbumFromArtist(
                                { ...job, metadata: existingMetadata },
                                "No sources available"
                            );

                        if (fallbackResult.retried && fallbackResult.jobId) {
                            return { success: true };
                        }
                    }
                }

                // Mark as failed with proper status text
                await prisma.downloadJob.update({
                    where: { id: jobId },
                    data: {
                        correlationId,
                        status: "failed",
                        error: error.message,
                        completedAt: new Date(),
                        metadata: {
                            ...existingMetadata,
                            statusText: "No sources available",
                            failedAt: new Date().toISOString(),
                        },
                    },
                });

                // Check batch completion for discovery jobs
                if (job?.discoveryBatchId) {
                    const { discoverWeeklyService } = await import(
                        "./discoverWeekly"
                    );
                    await discoverWeeklyService.checkBatchCompletion(
                        job.discoveryBatchId
                    );
                }

                return { success: false, error: error.message, errorType, isRecoverable };
            }

            // If album wasn't found, try same-artist fallback ONLY for non-discovery jobs
            // Discovery jobs should find NEW artists via the discovery system instead
            if (job && error.message?.includes("album not found")) {
                if (job.discoveryBatchId) {
                    logger.debug(
                        `   Album not found - Discovery job, skipping same-artist fallback`
                    );
                    logger.debug(
                        `   Discovery system will find a different artist instead`
                    );
                } else {
                    logger.debug(
                        `   Album not found - trying same-artist fallback...`
                    );

                    const artistMbid =
                        job.artistMbid || existingMetadata.artistMbid;

                    if (artistMbid) {
                        const fallbackResult =
                            await this.tryNextAlbumFromArtist(
                                { ...job, metadata: existingMetadata },
                                "Album not found in Lidarr"
                            );

                        if (fallbackResult.retried && fallbackResult.jobId) {
                            return { success: true };
                        }
                    }
                }
            }

            // No replacement found - mark as failed
            await prisma.downloadJob.update({
                where: { id: jobId },
                data: {
                    correlationId,
                    status: "failed",
                    error: error.message || "Failed to add album to Lidarr",
                    completedAt: new Date(),
                    metadata: {
                        ...existingMetadata,
                        statusText: "Failed to start",
                        failedAt: new Date().toISOString(),
                    },
                },
            });

            // Check batch completion for discovery jobs
            if (job?.discoveryBatchId) {
                const { discoverWeeklyService } = await import(
                    "./discoverWeekly"
                );
                await discoverWeeklyService.checkBatchCompletion(
                    job.discoveryBatchId
                );
            }

            return { success: false, error: error.message, errorType, isRecoverable };
        }
    }

    /**
     * Handle download grabbed event (from webhook)
     * Links the Lidarr downloadId to our job
     *
     * IMPORTANT: One logical album = one job, regardless of MBID.
     * MBIDs can differ between MusicBrainz and Lidarr, but artist+album name is canonical.
     */
    async onDownloadGrabbed(
        downloadId: string,
        albumMbid: string,
        albumTitle: string,
        artistName: string,
        lidarrAlbumId: number
    ): Promise<{ matched: boolean; jobId?: string }> {
        logger.debug(`[DOWNLOAD] Grabbed: ${artistName} - ${albumTitle}`);
        logger.debug(`   Download ID: ${downloadId}`);

        return await this.withTransaction(
            async (tx) => {
                // ═══════════════════════════════════════════════════════════════
                // STEP 1: Idempotency Check - Already processed?
                // ═══════════════════════════════════════════════════════════════
                const existingByRef = await tx.downloadJob.findFirst({
                    where: {
                        metadata: {
                            path: ["downloadId"],
                            equals: downloadId,
                        },
                    },
                });

                if (existingByRef) {
                    logger.debug(
                        `   Already tracked by job: ${existingByRef.id}`
                    );
                    return { matched: true, jobId: existingByRef.id };
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 2: Query Unassigned Jobs (Transaction ensures consistent view)
                // Only get jobs not yet assigned to a download (lidarrRef IS NULL)
                // ═══════════════════════════════════════════════════════════════
                const activeJobs = await tx.downloadJob.findMany({
                    where: {
                        status: { in: ["pending", "processing"] },
                        lidarrRef: null, // Not yet assigned to a download
                    },
                });

                logger.debug(
                    `   Found ${activeJobs.length} unassigned active job(s)`
                );

                // Normalize for matching
                const normalizedArtist = artistName?.toLowerCase().trim() || "";
                const normalizedAlbum = albumTitle?.toLowerCase().trim() || "";

                // ═══════════════════════════════════════════════════════════════
                // STEP 3: Apply Matching Strategies (In Priority Order)
                // ═══════════════════════════════════════════════════════════════
                let matchedJob: (typeof activeJobs)[0] | undefined;
                let matchStrategy = "";

                // Strategy 1: targetMbid
                matchedJob = activeJobs.find((j) => j.targetMbid === albumMbid);
                if (matchedJob) matchStrategy = "targetMbid";

                // Strategy 2: lidarrMbid in metadata
                if (!matchedJob) {
                    matchedJob = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        return meta?.lidarrMbid === albumMbid;
                    });
                    if (matchedJob) matchStrategy = "lidarrMbid";
                }

                // Strategy 3: lidarrAlbumId
                if (!matchedJob && lidarrAlbumId > 0) {
                    matchedJob = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        return (
                            (j as any).lidarrAlbumId === lidarrAlbumId ||
                            meta?.lidarrAlbumId === lidarrAlbumId
                        );
                    });
                    if (matchedJob) matchStrategy = "lidarrAlbumId";
                }

                // Strategy 4: Artist + Album name (canonical match)
                if (!matchedJob && normalizedArtist && normalizedAlbum) {
                    matchedJob = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        const candArtist =
                            meta?.artistName?.toLowerCase().trim() || "";
                        const candAlbum =
                            meta?.albumTitle?.toLowerCase().trim() || "";
                        return (
                            candArtist === normalizedArtist &&
                            candAlbum === normalizedAlbum
                        );
                    });
                    if (matchedJob) matchStrategy = "artist+album";
                }

                // Strategy 5: Subject field
                if (!matchedJob && normalizedArtist && normalizedAlbum) {
                    matchedJob = activeJobs.find((j) => {
                        const subject = j.subject?.toLowerCase().trim() || "";
                        return (
                            subject.includes(normalizedArtist) &&
                            subject.includes(normalizedAlbum)
                        );
                    });
                    if (matchedJob) matchStrategy = "subject";
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 4: Update Matched Job OR Create Tracking Job (Atomic)
                // ═══════════════════════════════════════════════════════════════
                if (matchedJob) {
                    logger.debug(
                        `   Matched by ${matchStrategy}: ${matchedJob.id}`
                    );

                    await tx.downloadJob.update({
                        where: { id: matchedJob.id },
                        data: {
                            status: "processing",
                            lidarrRef: downloadId,
                            lidarrAlbumId,
                            targetMbid: matchedJob.targetMbid || albumMbid,
                            metadata: {
                                ...((matchedJob.metadata as any) || {}),
                                downloadId,
                                lidarrMbid: albumMbid,
                                grabbedAt: new Date().toISOString(),
                            },
                        },
                    });

                    return { matched: true, jobId: matchedJob.id };
                }

                // No match - check for duplicates before creating tracking job
                logger.debug(`   No match found, checking for duplicates...`);

                // ═══════════════════════════════════════════════════════════════
                // DUPLICATE DETECTION: Prevent creating duplicate tracking jobs
                // This prevents the "Beatles Abbey Road" issue where the same
                // album is downloaded twice by SABnzbd, causing file deletions.
                // ═══════════════════════════════════════════════════════════════

                // Normalize for duplicate detection
                const normalizedArtistForDup = artistName?.toLowerCase().trim() || "";
                const normalizedAlbumForDup = albumTitle?.toLowerCase().trim() || "";

                // Check by MBID first (most reliable)
                let existingJob = null;
                if (albumMbid) {
                    existingJob = await tx.downloadJob.findFirst({
                        where: {
                            targetMbid: albumMbid,
                            status: { in: ["pending", "processing", "completed"] },
                        },
                    });
                }

                // If no MBID match, check by artist+album name
                if (!existingJob && normalizedArtistForDup && normalizedAlbumForDup) {
                    const candidateJobs = await tx.downloadJob.findMany({
                        where: {
                            status: { in: ["pending", "processing", "completed"] },
                        },
                    });

                    existingJob = candidateJobs.find((j) => {
                        const meta = j.metadata as any;
                        const candArtist = meta?.artistName?.toLowerCase().trim() || "";
                        const candAlbum = meta?.albumTitle?.toLowerCase().trim() || "";
                        return (
                            candArtist === normalizedArtistForDup &&
                            candAlbum === normalizedAlbumForDup
                        );
                    });
                }

                // If duplicate found, log warning and exit early
                if (existingJob) {
                    logger.warn(`[DownloadManager] Duplicate download detected`, {
                        artist: artistName,
                        album: albumTitle,
                        mbid: albumMbid,
                        existingJobId: existingJob.id,
                    });
                    return { matched: false };
                }

                logger.debug(`   No duplicates found, creating tracking job`);

                // Find user from recent artist download
                const recentJob = await tx.downloadJob.findFirst({
                    where: {
                        type: "artist",
                        status: { in: ["pending", "processing", "completed"] },
                    },
                    orderBy: { createdAt: "desc" },
                });

                if (!recentJob?.userId) {
                    logger.debug(
                        `   Cannot determine user, skipping job creation`
                    );
                    return { matched: false };
                }

                const trackingJob = await tx.downloadJob.create({
                    data: {
                        userId: recentJob.userId,
                        subject: `${artistName} - ${albumTitle}`,
                        type: "album",
                        targetMbid: albumMbid,
                        status: "processing",
                        lidarrRef: downloadId,
                        lidarrAlbumId,
                        attempts: 1,
                        metadata: {
                            artistName,
                            albumTitle,
                            downloadId,
                            grabbedAt: new Date().toISOString(),
                            source: "lidarr-auto-grab",
                        },
                    },
                });

                logger.debug(`   Created tracking job: ${trackingJob.id}`);
                return { matched: true, jobId: trackingJob.id };
            },
            { logPrefix: "[GRAB-TX]" }
        );
    }

    /**
     * Handle download complete event (from webhook)
     *
     * IMPORTANT: One logical album = one job. Match by name if MBID doesn't match.
     */
    async onDownloadComplete(
        downloadId: string,
        albumMbid?: string,
        artistName?: string,
        albumTitle?: string,
        lidarrAlbumId?: number
    ): Promise<{
        jobId?: string;
        batchId?: string;
        downloadBatchId?: string;
        spotifyImportJobId?: string;
    }> {
        logger.debug(`\n[COMPLETE] Download completed: ${downloadId}`);

        const result = await this.withTransaction(
            async (tx) => {
                // ═══════════════════════════════════════════════════════════════
                // STEP 1: Check if already completed (idempotency)
                // ═══════════════════════════════════════════════════════════════
                const completedJob = await tx.downloadJob.findFirst({
                    where: {
                        metadata: {
                            path: ["downloadId"],
                            equals: downloadId,
                        },
                        status: "completed",
                    },
                });

                if (completedJob) {
                    logger.debug(`   Already completed: ${completedJob.id}`);
                    const meta = completedJob.metadata as any;
                    return {
                        jobId: completedJob.id,
                        batchId: completedJob.discoveryBatchId || undefined,
                        downloadBatchId: meta?.batchId,
                        spotifyImportJobId: meta?.spotifyImportJobId,
                    };
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 2: Find Active Job
                // ═══════════════════════════════════════════════════════════════
                const activeJobs = await tx.downloadJob.findMany({
                    where: { status: { in: ["pending", "processing"] } },
                });

                const normalizedArtist = artistName?.toLowerCase().trim() || "";
                const normalizedAlbum = albumTitle?.toLowerCase().trim() || "";

                let job: (typeof activeJobs)[0] | undefined;

                // Strategy 1: lidarrRef
                job = activeJobs.find((j) => j.lidarrRef === downloadId);
                if (job) logger.debug(`    Matched by lidarrRef`);

                // Strategy 2: lidarrAlbumId
                if (!job && lidarrAlbumId) {
                    job = activeJobs.find(
                        (j) => j.lidarrAlbumId === lidarrAlbumId
                    );
                    if (job) logger.debug(`    Matched by lidarrAlbumId`);
                }

                // Strategy 3: previousDownloadIds
                if (!job) {
                    job = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        return meta?.previousDownloadIds?.includes(downloadId);
                    });
                    if (job) logger.debug(`    Matched by previousDownloadIds`);
                }

                // Strategy 4: MBID
                if (!job && albumMbid) {
                    job = activeJobs.find((j) => j.targetMbid === albumMbid);
                    if (!job) {
                        job = activeJobs.find(
                            (j) => (j.metadata as any)?.lidarrMbid === albumMbid
                        );
                    }
                    if (job) logger.debug(`    Matched by MBID`);
                }

                // Strategy 5: Name match
                if (!job && normalizedArtist && normalizedAlbum) {
                    job = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        const candArtist =
                            meta?.artistName?.toLowerCase().trim() || "";
                        const candAlbum =
                            meta?.albumTitle?.toLowerCase().trim() || "";
                        const subject = j.subject?.toLowerCase().trim() || "";

                        return (
                            (candArtist === normalizedArtist &&
                                candAlbum === normalizedAlbum) ||
                            (subject.includes(normalizedArtist) &&
                                subject.includes(normalizedAlbum))
                        );
                    });
                    if (job) logger.debug(`    Matched by name`);
                }

                if (!job) {
                    logger.debug(`   No matching job found`);
                    return {};
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 3: Find and Mark Duplicates Complete (Atomic)
                // ═══════════════════════════════════════════════════════════════
                const jobMeta = job.metadata as any;
                const jobArtist =
                    jobMeta?.artistName?.toLowerCase().trim() || "";
                const jobAlbum =
                    jobMeta?.albumTitle?.toLowerCase().trim() || "";

                const duplicateJobs = activeJobs.filter((j) => {
                    if (j.id === job!.id) return false;
                    const meta = j.metadata as any;
                    const candArtist =
                        meta?.artistName?.toLowerCase().trim() || "";
                    const candAlbum =
                        meta?.albumTitle?.toLowerCase().trim() || "";
                    return candArtist === jobArtist && candAlbum === jobAlbum;
                });

                if (duplicateJobs.length > 0) {
                    logger.debug(
                        `   Marking ${duplicateJobs.length} duplicate(s) complete`
                    );
                    await tx.downloadJob.updateMany({
                        where: { id: { in: duplicateJobs.map((j) => j.id) } },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            error: null,
                        },
                    });
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 4: Mark Primary Job Complete
                // ═══════════════════════════════════════════════════════════════
                await tx.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                        error: null,
                        metadata: {
                            ...jobMeta,
                            completedAt: new Date().toISOString(),
                        },
                    },
                });

                logger.debug(`   Job ${job.id} marked complete`);

                return {
                    jobId: job.id,
                    batchId: job.discoveryBatchId || undefined,
                    downloadBatchId: jobMeta?.batchId,
                    spotifyImportJobId: jobMeta?.spotifyImportJobId,
                    userId: job.userId,
                    subject: job.subject,
                    metadata: jobMeta,
                };
            },
            { logPrefix: "[COMPLETE-TX]" }
        );

        // Post-transaction operations (notifications, batch completion)
        if (result.jobId && result.userId) {
            // Send notification
            try {
                const decision =
                    await notificationPolicyService.evaluateNotification(
                        result.jobId,
                        "complete"
                    );

                if (decision.shouldNotify) {
                    logger.debug(
                        `   Sending completion notification: ${decision.reason}`
                    );
                    await notificationService.notifyDownloadComplete(
                        result.userId,
                        result.subject,
                        undefined,
                        result.metadata?.artistId
                    );

                    await prisma.downloadJob.update({
                        where: { id: result.jobId },
                        data: {
                            metadata: {
                                ...result.metadata,
                                notificationSent: true,
                            },
                        },
                    });
                } else {
                    logger.debug(
                        `   Suppressing completion notification: ${decision.reason}`
                    );
                }
            } catch (notifError) {
                logger.error(
                    "Failed to evaluate/send download notification:",
                    notifError
                );
            }

            // Check batch completion
            if (result.batchId) {
                const { discoverWeeklyService } = await import(
                    "./discoverWeekly"
                );
                await discoverWeeklyService.checkBatchCompletion(
                    result.batchId
                );
            }

            if (result.spotifyImportJobId) {
                const { spotifyImportService } = await import(
                    "./spotifyImport"
                );
                await spotifyImportService.checkImportCompletion(
                    result.spotifyImportJobId
                );
            }
        }

        return {
            jobId: result.jobId,
            batchId: result.batchId,
            downloadBatchId: result.downloadBatchId,
            spotifyImportJobId: result.spotifyImportJobId,
        };
    }

    /**
     * Handle import failure - LET LIDARR HANDLE RELEASE ITERATION
     *
     * Strategy:
     * 1. Blocklist the failed release with skipRedownload=false (Lidarr searches for alternatives)
     * 2. Track the failure but DON'T limit retries - let Lidarr exhaust all releases
     * 3. Only intervene when Lidarr has NO more releases (detected via stale job timeout)
     * 4. At that point, try a different album from the same artist
     */
    async onImportFailed(
        downloadId: string,
        reason: string,
        albumMbid?: string
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        logger.debug(`\n[RETRY] Import failed: ${downloadId}`);
        logger.debug(`   Reason: ${reason}`);

        const result = await this.withTransaction(
            async (tx) => {
                // ═══════════════════════════════════════════════════════════════
                // STEP 1: Find job and check for recent failure (DB-based dedup)
                // ═══════════════════════════════════════════════════════════════
                const job = await tx.downloadJob.findFirst({
                    where: {
                        OR: [
                            { lidarrRef: downloadId },
                            { targetMbid: albumMbid || undefined },
                        ],
                        status: "processing",
                    },
                });

                if (!job) {
                    logger.debug(`   No matching job found`);
                    return { retried: false, failed: false };
                }

                // Check for recent failure (deduplication)
                const metadata = (job.metadata as any) || {};
                const lastFailureAt = metadata.lastFailureAt;
                const FAILURE_DEDUP_WINDOW_MS = 30000; // 30 seconds

                if (lastFailureAt) {
                    const timeSinceLastFailure =
                        Date.now() - new Date(lastFailureAt).getTime();
                    if (timeSinceLastFailure < FAILURE_DEDUP_WINDOW_MS) {
                        logger.debug(
                            `   Duplicate failure (${Math.round(
                                timeSinceLastFailure / 1000
                            )}s ago), skipping`
                        );
                        return { retried: false, failed: false, jobId: job.id };
                    }
                }

                logger.debug(`   Found job: ${job.id}`);

                // ═══════════════════════════════════════════════════════════════
                // STEP 2: Update failure tracking
                // ═══════════════════════════════════════════════════════════════
                const failureCount = (metadata.failureCount || 0) + 1;
                const previousDownloadIds = metadata.previousDownloadIds || [];
                if (downloadId && !previousDownloadIds.includes(downloadId)) {
                    previousDownloadIds.push(downloadId);
                }

                // Update status text for retry attempts
                const lidarrAttempts = (metadata.lidarrAttempts || 1) + 1;
                const statusText = `Lidarr #${lidarrAttempts}`;

                await tx.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        lidarrRef: null, // Clear for next grab
                        metadata: {
                            ...metadata,
                            failureCount,
                            lastError: reason,
                            lastFailureAt: new Date().toISOString(),
                            previousDownloadIds,
                            lidarrAttempts,
                            statusText,
                        },
                    },
                });

                logger.debug(`   Failure #${failureCount} recorded`);

                return { retried: true, failed: false, jobId: job.id };
            },
            { logPrefix: "[FAIL-TX]" }
        );

        // Blocklist cleanup happens outside transaction
        if (result.retried) {
            logger.debug(`   Blocklisting and letting Lidarr find alternative`);
            await this.removeFromLidarrQueue(downloadId);
        } else if (!result.jobId) {
            // No job found - still clean up Lidarr queue
            await this.removeFromLidarrQueue(downloadId);
        }

        return result;
    }

    /**
     * Try the next album from the same artist when current album is exhausted
     * This is called when all releases for an album have been tried
     *
     * IMPORTANT:
     * - For Discovery Weekly jobs, we DON'T do same-artist fallback.
     *   Discovery should find NEW artists, not more albums from the same artist.
     * - For Spotify Import jobs, we DON'T do same-artist fallback.
     *   User wants EXACT playlist, not substitutes.
     */
    private async tryNextAlbumFromArtist(
        job: any,
        reason: string
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        const metadata = (job.metadata as any) || {};
        const artistMbid = job.artistMbid || metadata.artistMbid;
        const artistName = metadata.artistName;

        // CRITICAL: For Discovery Weekly, DON'T try same-artist fallback
        // Discovery should prioritize ARTIST DIVERSITY - let the discovery system
        // find a completely different artist instead
        if (job.discoveryBatchId) {
            logger.debug(
                `[RETRY] Discovery job - skipping same-artist fallback (diversity enforced)`
            );
            logger.debug(
                `   Discovery should find NEW artists, not more from: ${artistName}`
            );
            return await this.markJobExhausted(job, reason);
        }

        // CRITICAL: For Spotify Import, DON'T try same-artist fallback
        // User wants the EXACT playlist, not substitutes from same artist
        if (
            metadata.spotifyImportJobId ||
            metadata.downloadType === "spotify_import" ||
            metadata.noFallback
        ) {
            logger.debug(
                `[RETRY] Spotify Import job - skipping fallback (exact match required)`
            );
            logger.debug(`   User wants exact album: ${job.subject}`);

            // Mark as failed and trigger completion check
            const result = await this.markJobExhausted(job, reason);

            // Check if import is complete
            if (metadata.spotifyImportJobId) {
                const { spotifyImportService } = await import(
                    "./spotifyImport"
                );
                await spotifyImportService.checkImportCompletion(
                    metadata.spotifyImportJobId
                );
            }

            return result;
        }

        if (!artistMbid) {
            logger.debug(
                `   No artistMbid - cannot try other albums from same artist`
            );
            return await this.markJobExhausted(job, reason);
        }

        logger.debug(
            `[RETRY] Trying other albums from artist: ${
                artistName || artistMbid
            }`
        );

        try {
            // Get albums available in LIDARR for this artist (not MusicBrainz)
            // MusicBrainz has many obscure albums (bootlegs, live recordings) that Lidarr can't find
            const lidarrAlbums = await lidarrService.getArtistAlbums(
                artistMbid
            );

            if (!lidarrAlbums || lidarrAlbums.length === 0) {
                logger.debug(`   No albums found in Lidarr for artist`);
                return await this.markJobExhausted(job, reason);
            }

            logger.debug(
                `   Found ${lidarrAlbums.length} albums in Lidarr for artist`
            );

            // Get albums we've already tried
            const triedAlbumMbids = new Set<string>();

            // Check for other jobs with same artist
            const artistJobs = await prisma.downloadJob.findMany({
                where: {
                    artistMbid: artistMbid,
                    status: {
                        in: ["processing", "completed", "failed", "exhausted"],
                    },
                },
            });
            artistJobs.forEach((j: any) => {
                triedAlbumMbids.add(j.targetMbid);
            });

            // Also add current job's album
            triedAlbumMbids.add(job.targetMbid);

            // Filter to untried albums that exist in Lidarr
            const untriedAlbums = lidarrAlbums.filter(
                (album: any) => !triedAlbumMbids.has(album.foreignAlbumId)
            );

            logger.debug(`   Untried albums in Lidarr: ${untriedAlbums.length}`);

            if (untriedAlbums.length === 0) {
                logger.debug(`   All Lidarr albums from artist exhausted`);
                return await this.markJobExhausted(job, reason);
            }

            // Pick the first untried album (prioritize studio albums over singles/EPs if possible)
            const studioAlbums = untriedAlbums.filter(
                (a: any) =>
                    a.albumType?.toLowerCase() === "album" || !a.albumType
            );
            const nextAlbum =
                studioAlbums.length > 0 ? studioAlbums[0] : untriedAlbums[0];
            logger.debug(
                `[RETRY] Trying next album from same artist: ${nextAlbum.title}`
            );

            // Mark current job as exhausted (not failed - we're continuing with same artist)
            await prisma.downloadJob.update({
                where: { id: job.id },
                data: {
                    status: "exhausted",
                    error: `All releases exhausted - trying: ${nextAlbum.title}`,
                    completedAt: new Date(),
                },
            });

            // Use Lidarr's foreignAlbumId (MBID) for the new job
            const albumMbid = nextAlbum.foreignAlbumId;

            // Create new job for the next album
            const newJob = await prisma.downloadJob.create({
                data: {
                    userId: job.userId,
                    subject: `${artistName || "Unknown"} - ${nextAlbum.title}`,
                    type: "album",
                    targetMbid: albumMbid,
                    status: "pending",
                    discoveryBatchId: job.discoveryBatchId,
                    artistMbid: artistMbid,
                    metadata: {
                        artistName: artistName,
                        artistMbid: artistMbid,
                        albumTitle: nextAlbum.title,
                        albumMbid: albumMbid,
                        lidarrAlbumId: nextAlbum.id, // Store Lidarr album ID for faster lookup
                        sameArtistFallback: true,
                        originalJobId: job.id,
                        downloadType: metadata.downloadType || "library",
                        rootFolderPath: metadata.rootFolderPath || "/music",
                    },
                },
            });

            logger.debug(`   Created fallback job: ${newJob.id}`);

            // Start the download
            const result = await this.startDownload(
                newJob.id,
                artistName || "Unknown Artist",
                nextAlbum.title,
                albumMbid,
                job.userId
            );

            if (result.success) {
                logger.debug(`   Same-artist fallback download started`);
                return { retried: true, failed: false, jobId: newJob.id };
            } else {
                logger.debug(
                    `   Same-artist fallback failed to start: ${result.error}`
                );
                // The new job will be marked as failed by startDownload
                return { retried: false, failed: true, jobId: newJob.id };
            }
        } catch (error: any) {
            logger.error(
                `   Error trying same-artist fallback: ${error.message}`
            );
            return await this.markJobExhausted(job, reason);
        }
    }

    /**
     * Mark a job as exhausted (all releases and same-artist albums tried)
     *
     * IMPORTANT: Before failing, check if another job for the same album already succeeded.
     * This handles race conditions where duplicates exist and one succeeds.
     */
    private async markJobExhausted(
        job: any,
        reason: string
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        logger.debug(`[RETRY] Job fully exhausted: ${job.id}`);

        const meta = job.metadata as any;
        const artistName = meta?.artistName?.toLowerCase().trim() || "";
        const albumTitle = meta?.albumTitle?.toLowerCase().trim() || "";

        // Before marking as failed, check if another job for the same album already SUCCEEDED
        // This handles duplicate job scenarios
        if (artistName && albumTitle) {
            const completedDuplicate = await prisma.downloadJob.findFirst({
                where: {
                    id: { not: job.id },
                    status: "completed",
                },
            });

            if (completedDuplicate) {
                const dupMeta = completedDuplicate.metadata as any;
                const dupArtist =
                    dupMeta?.artistName?.toLowerCase().trim() || "";
                const dupAlbum =
                    dupMeta?.albumTitle?.toLowerCase().trim() || "";

                if (dupArtist === artistName && dupAlbum === albumTitle) {
                    logger.debug(
                        `   Found completed duplicate job ${completedDuplicate.id} - marking this as completed too`
                    );
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            error: null,
                            metadata: {
                                ...meta,
                                mergedWithJob: completedDuplicate.id,
                            },
                        },
                    });
                    return { retried: false, failed: false, jobId: job.id };
                }
            }
        }

        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "failed",
                error: `All releases and albums exhausted: ${reason}`,
                completedAt: new Date(),
            },
        });

        // Check batch completion for discovery jobs
        if (job.discoveryBatchId) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            await discoverWeeklyService.checkBatchCompletion(
                job.discoveryBatchId
            );
        }

        // Send failure notification using policy service
        try {
            const decision =
                await notificationPolicyService.evaluateNotification(
                    job.id,
                    "failed"
                );

            if (decision.shouldNotify) {
                logger.debug(
                    `   Sending failure notification: ${decision.reason}`
                );
                await notificationService.notifyDownloadFailed(
                    job.userId,
                    job.subject,
                    reason
                );

                // Mark notification as sent
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        metadata: {
                            ...meta,
                            notificationSent: true,
                        },
                    },
                });
            } else {
                logger.debug(
                    `   Suppressing failure notification: ${decision.reason}`
                );
            }
        } catch (notifError) {
            logger.error(
                "Failed to evaluate/send failure notification:",
                notifError
            );
        }

        return { retried: false, failed: true, jobId: job.id };
    }

    /**
     * Mark stale jobs as failed (called by cleanup job)
     * - Pending jobs (never started) timeout after 3 minutes = "download never started"
     * - Processing jobs with no lidarrRef (never grabbed) timeout after 2 minutes = "no sources found"
     * - Processing jobs with lidarrRef (grabbed but not imported) timeout after 5 minutes = "import failed"
     */
    async markStaleJobsAsFailed(): Promise<number> {
        const pendingCutoff = new Date(Date.now() - this.PENDING_TIMEOUT_MS); // 30 minutes for pending (batch processing)
        const noSourceCutoff = new Date(Date.now() - this.NO_SOURCE_TIMEOUT_MS);
        const importCutoff = new Date(Date.now() - this.IMPORT_TIMEOUT_MS);

        // Find all pending and processing jobs
        const activeJobs = await prisma.downloadJob.findMany({
            where: { status: { in: ["pending", "processing"] } },
        });

        // Log to session for debugging Spotify imports
        if (activeJobs.length > 0) {
            const spotifyJobs = activeJobs.filter((j) =>
                j.id.startsWith("spotify_")
            );
            if (spotifyJobs.length > 0) {
                sessionLog(
                    "CLEANUP",
                    `Checking ${activeJobs.length} active jobs (${spotifyJobs.length} Spotify import)`
                );
            }
        }

        // Separate pending from processing
        const pendingJobs = activeJobs.filter((j) => j.status === "pending");
        const processingJobs = activeJobs.filter(
            (j) => j.status === "processing"
        );

        // Handle old pending jobs first (they never started)
        const stalePendingJobs = pendingJobs.filter(
            (job) => job.createdAt < pendingCutoff
        );

        if (stalePendingJobs.length > 0) {
            logger.debug(
                `\n⏰ Found ${stalePendingJobs.length} stuck PENDING jobs (never started)`
            );
            sessionLog(
                "CLEANUP",
                `Found ${stalePendingJobs.length} stuck PENDING jobs`
            );

            for (const job of stalePendingJobs) {
                logger.debug(
                    `   Timing out: ${
                        job.subject
                    } (never started - ${Math.round(
                        (Date.now() - job.createdAt.getTime()) / 60000
                    )}m old)`
                );

                // Mark as failed
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "failed",
                        error: "Download never started - timed out",
                        completedAt: new Date(),
                    },
                });

                // Check batch completion for discovery jobs
                if (job.discoveryBatchId) {
                    const { discoverWeeklyService } = await import(
                        "./discoverWeekly"
                    );
                    await discoverWeeklyService.checkBatchCompletion(
                        job.discoveryBatchId
                    );
                }
            }
        }

        if (processingJobs.length === 0) {
            return 0;
        }

        const staleJobs: typeof processingJobs = [];

        // Import lidarr service for active download check
        const { isDownloadActive } = await import("./lidarr");

        for (const job of processingJobs) {
            const metadata = job.metadata as any;
            const startedAt = metadata?.startedAt
                ? new Date(metadata.startedAt)
                : job.createdAt;

            // Skip Soulseek jobs - they complete immediately with direct slsk-client
            // Old SLSKD jobs used source: "slskd", new direct jobs use source: "soulseek_direct"
            if (
                metadata?.source === "slskd" ||
                metadata?.source === "soulseek_direct"
            ) {
                logger.debug(
                    `   ${job.subject}: Soulseek download, skipping stale check`
                );
                sessionLog(
                    "CLEANUP",
                    `Skipping Soulseek job: ${job.subject} (status: ${job.status})`
                );
                continue;
            }

            // Jobs without lidarrRef = Lidarr never grabbed = no sources found
            if (!job.lidarrRef) {
                if (startedAt < noSourceCutoff) {
                    staleJobs.push(job);
                }
            } else {
                // Jobs with lidarrRef = grabbed but potentially still downloading
                if (startedAt < importCutoff) {
                    // Check if Lidarr is still actively downloading before timing out
                    const downloadStatus = await isDownloadActive(
                        job.lidarrRef
                    );

                    if (downloadStatus.active) {
                        // Still downloading - extend the timeout, don't mark as stale
                        logger.debug(
                            `   ${job.subject}: Still downloading (${
                                downloadStatus.progress || 0
                            }%), extending timeout`
                        );

                        // Update the startedAt to extend the timeout
                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                metadata: {
                                    ...metadata,
                                    startedAt: new Date().toISOString(),
                                    extendedTimeout: true,
                                },
                            },
                        });
                    } else {
                        // Not actively downloading - mark as stale
                        staleJobs.push(job);
                    }
                }
            }
        }

        if (staleJobs.length === 0) {
            return 0;
        }

        logger.debug(`\n⏰ Found ${staleJobs.length} stale download jobs`);
        sessionLog(
            "CLEANUP",
            `Found ${staleJobs.length} stale jobs to mark as failed`
        );

        // Track unique batch IDs to check
        const batchIds = new Set<string>();
        const downloadBatchIds = new Set<string>();

        for (const job of staleJobs) {
            const metadata = (job.metadata as any) || {};

            // Before marking as failed, check if still in retry window using policy service
            try {
                const policyDecision =
                    await notificationPolicyService.evaluateNotification(
                        job.id,
                        "timeout"
                    );

                // If policy says to extend timeout (still in retry window), do so
                if (
                    policyDecision.reason.includes("retry window") ||
                    policyDecision.reason.includes("extending timeout")
                ) {
                    logger.debug(
                        `   ${job.subject}: ${policyDecision.reason} - extending timeout`
                    );
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            metadata: {
                                ...metadata,
                                startedAt: new Date().toISOString(),
                                timeoutExtendedByPolicy: true,
                            },
                        },
                    });
                    continue; // Skip to next job
                }
            } catch (policyError) {
                logger.error(
                    `   Failed to evaluate policy for ${job.id}:`,
                    policyError
                );
                // Continue with failure handling if policy check fails
            }

            const hasLidarrRef = !!job.lidarrRef;
            const errorMessage = hasLidarrRef
                ? `Import failed - download stuck for ${
                      this.IMPORT_TIMEOUT_MS / 60000
                  } minutes`
                : `No sources found - no indexer results`;

            logger.debug(
                `   Timing out: ${job.subject} (${
                    hasLidarrRef ? "stuck import" : "no sources"
                })`
            );
            sessionLog(
                "CLEANUP",
                `Marking stale: ${job.subject} - ${errorMessage}`
            );
            const artistName = metadata?.artistName?.toLowerCase().trim() || "";
            const albumTitle = metadata?.albumTitle?.toLowerCase().trim() || "";

            // FIRST: Check if a COMPLETED job already exists for this album
            // This handles the case where a duplicate job succeeded while this one was processing
            if (artistName && albumTitle) {
                const completedDuplicate = await prisma.downloadJob.findFirst({
                    where: {
                        id: { not: job.id },
                        status: "completed",
                    },
                });

                if (completedDuplicate) {
                    const dupMeta = completedDuplicate.metadata as any;
                    const dupArtist =
                        dupMeta?.artistName?.toLowerCase().trim() || "";
                    const dupAlbum =
                        dupMeta?.albumTitle?.toLowerCase().trim() || "";

                    if (dupArtist === artistName && dupAlbum === albumTitle) {
                        logger.debug(
                            `   Found completed duplicate - marking this job as completed too`
                        );
                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                status: "completed",
                                completedAt: new Date(),
                                error: null,
                                metadata: {
                                    ...metadata,
                                    mergedWithJob: completedDuplicate.id,
                                },
                            },
                        });
                        continue; // Skip to next stale job
                    }
                }
            }

            // Clean up from Lidarr queue if possible
            const lidarrAlbumId = (job as any).lidarrAlbumId;
            if (lidarrAlbumId && job.lidarrRef) {
                await this.blocklistAndRetry(job.lidarrRef, lidarrAlbumId);
            }

            // Use same-artist fallback ONLY for non-discovery jobs
            // Discovery jobs should find NEW artists via the discovery system
            let replacementStarted = false;
            const artistMbid = job.artistMbid || metadata.artistMbid;

            if (artistMbid && !job.discoveryBatchId) {
                logger.debug(`   Attempting same-artist fallback...`);
                try {
                    const fallbackResult = await this.tryNextAlbumFromArtist(
                        { ...job, metadata },
                        errorMessage
                    );
                    if (fallbackResult.retried && fallbackResult.jobId) {
                        logger.debug(
                            `   Same-artist fallback started: ${fallbackResult.jobId}`
                        );
                        replacementStarted = true;
                    }
                } catch (fallbackErr: any) {
                    logger.error(
                        `   Same-artist fallback error: ${fallbackErr.message}`
                    );
                }
            } else if (job.discoveryBatchId) {
                logger.debug(
                    `   Discovery job - letting discovery system find new artist`
                );
            }

            // If no replacement was started, mark the original job as failed
            // NOTE: No notification here - stale cleanup is a background safety net
            // Notifications are only sent from markJobExhausted when truly exhausted
            if (!replacementStarted) {
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "failed",
                        error: errorMessage,
                        completedAt: new Date(),
                    },
                });
            }

            if (job.discoveryBatchId) {
                batchIds.add(job.discoveryBatchId);
            }

            // Track download batch IDs for artist downloads
            if (metadata?.batchId) {
                downloadBatchIds.add(metadata.batchId);
            }
        }

        // Check discovery batch completion for affected batches
        if (batchIds.size > 0) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            for (const batchId of batchIds) {
                logger.debug(
                    `   Checking discovery batch completion: ${batchId}`
                );
                await discoverWeeklyService.checkBatchCompletion(batchId);
            }
        }

        return staleJobs.length;
    }

    /**
     * Blocklist a failed release and let Lidarr search for alternatives
     * skipRedownload=false tells Lidarr to automatically search for another release
     */
    private async blocklistAndRetry(
        downloadId: string,
        _lidarrAlbumId: number
    ) {
        try {
            const settings = await getSystemSettings();
            if (!settings?.lidarrUrl || !settings?.lidarrApiKey) return;

            // Get queue to find the specific release
            try {
                const queueResponse = await axios.get(
                    `${settings.lidarrUrl}/api/v1/queue`,
                    {
                        headers: { "X-Api-Key": settings.lidarrApiKey },
                        timeout: 10000,
                    }
                );

                const queueItem = queueResponse.data.records?.find(
                    (item: any) => item.downloadId === downloadId
                );

                if (queueItem) {
                    // Remove from queue with blocklist=true and skipRedownload=false
                    // Lidarr will automatically search for another release
                    await axios.delete(
                        `${settings.lidarrUrl}/api/v1/queue/${queueItem.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );
                    logger.debug(
                        `   Blocklisted release, Lidarr searching for alternative`
                    );
                }
            } catch (queueError: any) {
                // Queue item may have already been removed
                logger.debug(`   Queue cleanup: ${queueError.message}`);
            }
        } catch (error: any) {
            logger.error(`   Blocklist/retry failed:`, error.message);
        }
    }

    /**
     * Remove a failed download from Lidarr's queue (without retrying)
     * Used when we don't have a tracking job but still need to clean up
     */
    private async removeFromLidarrQueue(downloadId: string) {
        try {
            const settings = await getSystemSettings();
            if (!settings?.lidarrUrl || !settings?.lidarrApiKey) return;

            const queueResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/queue`,
                {
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 10000,
                }
            );

            const queueItem = queueResponse.data.records?.find(
                (item: any) => item.downloadId === downloadId
            );

            if (queueItem) {
                // Remove from queue with blocklist=true and skipRedownload=false
                // skipRedownload=false tells Lidarr to search for another release
                await axios.delete(
                    `${settings.lidarrUrl}/api/v1/queue/${queueItem.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
                    {
                        headers: { "X-Api-Key": settings.lidarrApiKey },
                        timeout: 10000,
                    }
                );
                logger.debug(
                    `   Removed from Lidarr queue, blocklisted, triggering new search`
                );
            } else {
                logger.debug(
                    `   Item not found in Lidarr queue (may already be removed)`
                );
            }
        } catch (error: any) {
            logger.error(
                `   Failed to remove from Lidarr queue:`,
                error.message
            );
        }
    }

    /**
     * Clear all failed/stuck items from Lidarr's download queue
     * and trigger new searches for the albums
     */
    async clearLidarrQueue(): Promise<{ removed: number; errors: string[] }> {
        const errors: string[] = [];
        let removed = 0;
        const albumIdsToSearch: number[] = [];

        try {
            const settings = await getSystemSettings();
            if (!settings?.lidarrUrl || !settings?.lidarrApiKey) {
                return { removed: 0, errors: ["Lidarr not configured"] };
            }

            logger.debug(`\nClearing Lidarr download queue...`);

            const queueResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/queue`,
                {
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 10000,
                }
            );

            const records = queueResponse.data.records || [];

            if (records.length === 0) {
                return { removed: 0, errors: [] };
            }

            logger.debug(`   Found ${records.length} items in queue`);

            // Filter for failed/warning status items
            const failedItems = records.filter(
                (item: any) =>
                    item.status === "warning" ||
                    item.status === "failed" ||
                    item.trackedDownloadStatus === "warning" ||
                    item.trackedDownloadStatus === "error" ||
                    item.trackedDownloadState === "importPending" ||
                    item.trackedDownloadState === "importFailed" ||
                    (item.statusMessages && item.statusMessages.length > 0)
            );

            if (failedItems.length === 0) {
                return { removed: 0, errors: [] };
            }

            logger.debug(`   ${failedItems.length} items have errors/warnings`);

            for (const item of failedItems) {
                try {
                    // Collect album IDs for re-search
                    if (item.albumId) {
                        albumIdsToSearch.push(item.albumId);
                    }

                    // Remove from queue with blocklist
                    await axios.delete(
                        `${settings.lidarrUrl}/api/v1/queue/${item.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );
                    logger.debug(
                        `    Removed: ${
                            item.title || item.album?.title || "Unknown"
                        }`
                    );
                    removed++;
                } catch (error: any) {
                    const msg = `Failed to remove ${item.id}: ${error.message}`;
                    logger.debug(` ${msg}`);
                    errors.push(msg);
                }
            }

            // Explicitly trigger album searches for removed items
            if (albumIdsToSearch.length > 0) {
                try {
                    logger.debug(
                        `    Triggering search for ${albumIdsToSearch.length} album(s)...`
                    );
                    await axios.post(
                        `${settings.lidarrUrl}/api/v1/command`,
                        {
                            name: "AlbumSearch",
                            albumIds: albumIdsToSearch,
                        },
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );
                    logger.debug(
                        `    Search triggered for alternative releases`
                    );
                } catch (searchError: any) {
                    logger.debug(
                        ` Failed to trigger search: ${searchError.message}`
                    );
                }
            }

            logger.debug(`   Removed ${removed} items from queue`);
            return { removed, errors };
        } catch (error: any) {
            logger.error(`   Queue cleanup failed:`, error.message);
            return { removed, errors: [error.message] };
        }
    }

    /**
     * Get statistics about current downloads
     */
    async getStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
    }> {
        const [pending, processing, completed, failed] = await Promise.all([
            prisma.downloadJob.count({ where: { status: "pending" } }),
            prisma.downloadJob.count({ where: { status: "processing" } }),
            prisma.downloadJob.count({ where: { status: "completed" } }),
            prisma.downloadJob.count({ where: { status: "failed" } }),
        ]);

        return { pending, processing, completed, failed };
    }

    /**
     * Reconcile processing jobs with Lidarr
     * Checks if albums in "processing" state are already available in Lidarr
     * and marks them as completed if so (fixes missed webhook completion events)
     *
     * IMPORTANT: Checks by both MBID and artist+album name to handle MBID mismatches
     */
    async reconcileWithLidarr(): Promise<{
        reconciled: number;
        errors: string[];
    }> {
        logger.debug(`\n[RECONCILE] Checking processing jobs against Lidarr...`);

        const processingJobs = await prisma.downloadJob.findMany({
            where: { status: "processing" },
        });

        if (processingJobs.length === 0) {
            logger.debug(`   No processing jobs to reconcile`);
            return { reconciled: 0, errors: [] };
        }

        logger.debug(`   Found ${processingJobs.length} processing job(s)`);

        let reconciled = 0;
        const errors: string[] = [];

        for (const job of processingJobs) {
            const metadata = job.metadata as any;
            const albumMbid =
                job.targetMbid || metadata?.albumMbid || metadata?.lidarrMbid;
            const artistName = metadata?.artistName;
            const albumTitle = metadata?.albumTitle;

            try {
                let isAvailable = false;

                // Strategy 1: Check by MBID(s)
                if (albumMbid) {
                    isAvailable = await lidarrService.isAlbumAvailable(
                        albumMbid
                    );

                    // Also try lidarrMbid if different
                    if (
                        !isAvailable &&
                        metadata?.lidarrMbid &&
                        metadata.lidarrMbid !== albumMbid
                    ) {
                        isAvailable = await lidarrService.isAlbumAvailable(
                            metadata.lidarrMbid
                        );
                    }
                }

                // Strategy 2: Check by artist+album name (handles MBID mismatches)
                if (!isAvailable && artistName && albumTitle) {
                    isAvailable = await lidarrService.isAlbumAvailableByTitle(
                        artistName,
                        albumTitle
                    );
                }

                // Strategy 3: Parse subject if no metadata (format: "Artist - Album")
                if (!isAvailable && !artistName && job.subject) {
                    const parts = job.subject.split(" - ");
                    if (parts.length >= 2) {
                        const parsedArtist = parts[0].trim();
                        const parsedAlbum = parts.slice(1).join(" - ").trim();
                        isAvailable =
                            await lidarrService.isAlbumAvailableByTitle(
                                parsedArtist,
                                parsedAlbum
                            );
                    }
                }

                if (isAvailable) {
                    logger.debug(
                        `   Job ${job.id}: Album "${job.subject}" found in Lidarr - marking complete`
                    );

                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            error: null,
                            metadata: {
                                ...metadata,
                                completedAt: new Date().toISOString(),
                                reconciledFromLidarr: true,
                            },
                        },
                    });

                    // Check batch completion for discovery jobs
                    if (job.discoveryBatchId) {
                        const { discoverWeeklyService } = await import(
                            "./discoverWeekly"
                        );
                        await discoverWeeklyService.checkBatchCompletion(
                            job.discoveryBatchId
                        );
                    }

                    reconciled++;
                } else {
                    // Only log for jobs older than 5 minutes
                    const jobAge = Date.now() - (job.createdAt?.getTime() || 0);
                    if (jobAge > 5 * 60 * 1000) {
                        logger.debug(
                            `   Job ${job.id}: "${
                                job.subject
                            }" not yet available in Lidarr (${Math.round(
                                jobAge / 60000
                            )}m old)`
                        );
                    }
                }
            } catch (error: any) {
                const msg = `Job ${job.id}: Error checking Lidarr - ${error.message}`;
                logger.error(`   ${msg}`);
                errors.push(msg);
            }
        }

        logger.debug(`[RECONCILE] Reconciled ${reconciled} job(s)`);
        return { reconciled, errors };
    }

    /**
     * Sync with Lidarr's queue to detect cancelled/orphaned downloads
     * This catches jobs that were cancelled in Lidarr's UI but webhooks didn't notify us
     *
     * IMPORTANT: Implements grace period to prevent false cancellations when Lidarr
     * auto-retries with a different release (new downloadId). Missing downloads are
     * only marked as cancelled after 3 sync checks (90 seconds), and replacement
     * detection handles downloadId changes.
     */
    async syncWithLidarrQueue(): Promise<{
        cancelled: number;
        errors: string[];
    }> {
        logger.debug(
            `\n[QUEUE-SYNC] Syncing processing jobs with Lidarr queue...`
        );

        // Grace period tracking happens in metadata.queueSyncMissingCount

        const processingJobs = await prisma.downloadJob.findMany({
            where: {
                status: "processing",
                lidarrRef: { not: null }, // Only check jobs that have been grabbed
            },
        });

        if (processingJobs.length === 0) {
            logger.debug(`   No processing jobs with lidarrRef to sync`);
            return { cancelled: 0, errors: [] };
        }

        logger.debug(
            `   Found ${processingJobs.length} processing job(s) with lidarrRef`
        );

        try {
            // Get current Lidarr queue
            const { getQueue } = await import("./lidarr");
            const queueItems = await getQueue();

            if (queueItems.length === 0) {
                logger.debug(`   Lidarr queue is empty`);
            } else {
                logger.debug(`   Lidarr queue has ${queueItems.length} item(s)`);
            }

            // Build set of downloadIds currently in Lidarr queue
            const activeDownloadIds = new Set(
                queueItems.map((item) => item.downloadId)
            );

            let cancelled = 0;
            const errors: string[] = [];

            // Check each processing job
            for (const job of processingJobs) {
                if (!job.lidarrRef) continue;

                const metadata = job.metadata as any;
                const artistName = metadata?.artistName;
                const albumTitle = metadata?.albumTitle;

                // If download is found in queue, reset its missing counter and continue
                if (activeDownloadIds.has(job.lidarrRef)) {
                    // Reset missing counter if it was previously set
                    if (metadata?.queueSyncMissingCount && metadata.queueSyncMissingCount > 0) {
                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                metadata: {
                                    ...metadata,
                                    queueSyncMissingCount: 0,
                                    lastQueueSyncFound: new Date().toISOString(),
                                },
                            },
                        });
                    }
                    continue;
                }

                // Download ID not found in queue - start grace period tracking
                logger.debug(
                    `   Job ${job.id}: Download ID "${job.lidarrRef}" not in queue`
                );
                logger.debug(`     Album: ${artistName} - ${albumTitle}`);

                // Track missing download attempts for grace period
                const missingKey = `missing_${job.id}`;
                const missingCount = (metadata?.queueSyncMissingCount || 0) + 1;

                if (missingCount < 3) {
                    logger.debug(
                        `     Download missing from queue (attempt ${missingCount}/3) - grace period active`
                    );

                    // Update missing count in metadata
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            metadata: {
                                ...metadata,
                                queueSyncMissingCount: missingCount,
                                lastQueueSyncCheck: new Date().toISOString(),
                            },
                        },
                    });
                    continue; // Don't mark as cancelled yet
                }

                // After 3 checks (90 seconds), check for replacement downloads before cancelling
                logger.debug(
                    `     Download missing after 3 checks - checking for replacement`
                );

                // Check if replacement download exists (same album, different downloadId)
                // QueueItem.title typically contains "Artist - Album", so check if it includes the album name
                const replacementDownload = queueItems.find((item) => {
                    if (!item.downloadId || !albumTitle) return false;
                    
                    const queueTitle = item.title?.toLowerCase() || "";
                    const searchAlbum = albumTitle.toLowerCase();
                    const searchArtist = artistName?.toLowerCase() || "";
                    
                    // Match if queue title contains both artist and album
                    return (
                        queueTitle.includes(searchAlbum) &&
                        (searchArtist ? queueTitle.includes(searchArtist) : true)
                    );
                });

                if (replacementDownload && replacementDownload.downloadId) {
                    logger.debug(
                        `     Replacement download found: ${replacementDownload.downloadId}`
                    );
                    logger.debug(
                        `     Updating job with new downloadId (Lidarr auto-retry detected)`
                    );

                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            lidarrRef: replacementDownload.downloadId,
                            error: null,
                            metadata: {
                                ...metadata,
                                previousDownloadId: job.lidarrRef,
                                replacementDetected: true,
                                replacementDetectedAt: new Date().toISOString(),
                                queueSyncMissingCount: 0, // Reset counter
                            },
                        },
                    });

                    continue; // Job is still active with new downloadId
                }

                // No replacement found - check if the album is already downloaded
                try {
                    let isAvailable = false;

                    if (job.targetMbid) {
                        isAvailable = await lidarrService.isAlbumAvailable(
                            job.targetMbid
                        );
                    }

                    if (!isAvailable && artistName && albumTitle) {
                        isAvailable =
                            await lidarrService.isAlbumAvailableByTitle(
                                artistName,
                                albumTitle
                            );
                    }

                    if (isAvailable) {
                        // Album is downloaded - mark as completed
                        logger.debug(
                            `     Album found in library - marking complete`
                        );
                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                status: "completed",
                                completedAt: new Date(),
                                error: null,
                                metadata: {
                                    ...metadata,
                                    completedAt: new Date().toISOString(),
                                    queueSyncCompleted: true,
                                    queueSyncMissingCount: 0,
                                },
                            },
                        });
                        cancelled++;
                    } else {
                        // Album not downloaded, not in queue, no replacement - mark as failed
                        logger.warn(
                            `     Download not found after 90s (3 checks) - marking as failed`
                        );
                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                status: "failed",
                                error: "Lidarr queue sync: Download not found after 90s (3 checks). Possible reasons: indexer timeout, quality profile mismatch, or Lidarr auto-cancelled.",
                                completedAt: new Date(),
                                lidarrRef: null,
                                metadata: {
                                    ...metadata,
                                    cancelledAt: new Date().toISOString(),
                                    queueSyncCancelled: true,
                                    queueSyncMissingCount: missingCount,
                                },
                            },
                        });

                        // Check batch completion for discovery jobs
                        if (job.discoveryBatchId) {
                            const { discoverWeeklyService } = await import(
                                "./discoverWeekly"
                            );
                            await discoverWeeklyService.checkBatchCompletion(
                                job.discoveryBatchId
                            );
                        }

                        cancelled++;
                    }
                } catch (error: any) {
                    const msg = `Job ${job.id}: Error checking album availability - ${error.message}`;
                    logger.error(`     ${msg}`);
                    errors.push(msg);
                }
            }

            logger.debug(`[QUEUE-SYNC] Processed ${cancelled} orphaned job(s)`);
            return { cancelled, errors };
        } catch (error: any) {
            logger.error(
                `[QUEUE-SYNC] Failed to sync with Lidarr queue:`,
                error.message
            );
            return { cancelled: 0, errors: [error.message] };
        }
    }
}

// Singleton instance
export const simpleDownloadManager = new SimpleDownloadManager();
