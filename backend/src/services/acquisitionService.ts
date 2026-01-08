/**
 * Unified Acquisition Service
 *
 * Consolidates album/track acquisition logic from Discovery Weekly and Playlist Import.
 * Handles download source selection, behavior matrix routing, and job tracking.
 *
 * Phase 2.1: Initial implementation
 * - Behavior matrix logic for primary/fallback source selection
 * - Soulseek album acquisition (track list → batch download)
 * - Lidarr album acquisition (webhook-based completion)
 * - DownloadJob management with context-based tracking
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import { soulseekService } from "./soulseek";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { musicBrainzService } from "./musicbrainz";
import { lastFmService } from "./lastfm";
import { AcquisitionError, AcquisitionErrorType } from "./lidarr";
import PQueue from "p-queue";

// ============================================
// TYPE DEFINITIONS
// ============================================

/**
 * Context for tracking acquisition origin
 * Used to link download jobs to their source (Discovery batch or Spotify import)
 */
export interface AcquisitionContext {
    userId: string;
    discoveryBatchId?: string;
    spotifyImportJobId?: string;
    existingJobId?: string;
}

/**
 * Request to acquire an album
 */
export interface AlbumAcquisitionRequest {
    albumTitle: string;
    artistName: string;
    mbid?: string;
    lastfmUrl?: string;
    requestedTracks?: Array<{ title: string; position?: number }>;
}

/**
 * Request to acquire individual tracks (for Unknown Album case)
 */
export interface TrackAcquisitionRequest {
    trackTitle: string;
    artistName: string;
    albumTitle?: string;
}

/**
 * Result of an acquisition attempt
 */
export interface AcquisitionResult {
    success: boolean;
    downloadJobId?: number;
    source?: "soulseek" | "lidarr";
    error?: string;
    errorType?: AcquisitionErrorType;
    isRecoverable?: boolean;
    tracksDownloaded?: number;
    tracksTotal?: number;
    correlationId?: string;
}

/**
 * Service availability check result
 */
interface ServiceAvailability {
    lidarrAvailable: boolean;
    soulseekAvailable: boolean;
}

/**
 * Download behavior matrix configuration
 */
interface DownloadBehavior {
    hasPrimarySource: boolean;
    primarySource: "soulseek" | "lidarr" | null;
    hasFallbackSource: boolean;
    fallbackSource: "soulseek" | "lidarr" | null;
}

// ============================================
// ACQUISITION SERVICE
// ============================================

class AcquisitionService {
    private albumQueue: PQueue;

    constructor() {
        // Initialize album queue with concurrency of 2 (configurable)
        this.albumQueue = new PQueue({ concurrency: 2 });
        logger.debug(
            "[Acquisition] Initialized album queue with concurrency=2"
        );
    }

    /**
     * Get download behavior configuration (settings + service availability)
     * Auto-detects and selects download source based on actual availability
     */
    private async getDownloadBehavior(): Promise<DownloadBehavior> {
        const settings = await getSystemSettings();

        // Get download source settings
        const downloadSource = settings?.downloadSource || "soulseek";
        const primaryFailureFallback =
            settings?.primaryFailureFallback || "none";

        // Determine actual availability
        const hasSoulseek = await soulseekService.isAvailable();
        const hasLidarr = !!(
            settings?.lidarrEnabled &&
            settings?.lidarrUrl &&
            settings?.lidarrApiKey
        );

        // Case 1: No sources available
        if (!hasSoulseek && !hasLidarr) {
            logger.debug(
                "[Acquisition] Available sources: Lidarr=false, Soulseek=false"
            );
            logger.error("[Acquisition] No download sources configured");
            return {
                hasPrimarySource: false,
                primarySource: null,
                hasFallbackSource: false,
                fallbackSource: null,
            };
        }

        // Case 2: Only one source available - use it regardless of preference
        if (hasSoulseek && !hasLidarr) {
            logger.debug(
                "[Acquisition] Available sources: Lidarr=false, Soulseek=true"
            );
            logger.debug(
                "[Acquisition] Using Soulseek as primary source (only source available)"
            );
            logger.debug(
                "[Acquisition] No fallback configured (only one source available)"
            );
            return {
                hasPrimarySource: true,
                primarySource: "soulseek",
                hasFallbackSource: false,
                fallbackSource: null,
            };
        }

        if (hasLidarr && !hasSoulseek) {
            logger.debug(
                "[Acquisition] Available sources: Lidarr=true, Soulseek=false"
            );
            logger.debug(
                "[Acquisition] Using Lidarr as primary source (only source available)"
            );
            logger.debug(
                "[Acquisition] No fallback configured (only one source available)"
            );
            return {
                hasPrimarySource: true,
                primarySource: "lidarr",
                hasFallbackSource: false,
                fallbackSource: null,
            };
        }

        // Case 3: Both available - respect user preference for primary
        const userPrimary = downloadSource; // "soulseek" or "lidarr"
        const alternative = userPrimary === "soulseek" ? "lidarr" : "soulseek";

        // Auto-enable fallback if both sources are configured and no explicit setting
        let useFallback =
            primaryFailureFallback !== "none" &&
            primaryFailureFallback === alternative;

        // Auto-fallback: If both sources available and no explicit fallback set, enable it
        if (!useFallback && primaryFailureFallback === "none") {
            useFallback = true;
            logger.debug(
                `[Acquisition] Auto-enabled fallback: ${alternative} (both sources configured)`
            );
        }

        logger.debug(
            "[Acquisition] Available sources: Lidarr=true, Soulseek=true"
        );
        logger.debug(
            `[Acquisition] Using ${userPrimary} as primary source (user preference)`
        );
        logger.debug(
            `[Acquisition] Fallback configured: ${
                useFallback ? alternative : "none"
            }`
        );

        return {
            hasPrimarySource: true,
            primarySource: userPrimary,
            hasFallbackSource: useFallback,
            fallbackSource: useFallback ? alternative : null,
        };
    }

    /**
     * Update download job with source-specific status text
     * Stored in metadata for frontend display
     */
    private async updateJobStatusText(
        jobId: string,
        source: "lidarr" | "soulseek",
        attemptNumber: number
    ): Promise<void> {
        const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1);
        const statusText = `${sourceLabel} #${attemptNumber}`;

        const job = await prisma.downloadJob.findUnique({
            where: { id: jobId },
            select: { metadata: true },
        });
        const existingMetadata = (job?.metadata as any) || {};

        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                metadata: {
                    ...existingMetadata,
                    currentSource: source,
                    lidarrAttempts:
                        source === "lidarr"
                            ? attemptNumber
                            : existingMetadata.lidarrAttempts || 0,
                    soulseekAttempts:
                        source === "soulseek"
                            ? attemptNumber
                            : existingMetadata.soulseekAttempts || 0,
                    statusText,
                },
            },
        });

        logger.debug(`[Acquisition] Updated job ${jobId}: ${statusText}`);
    }

    /**
     * Acquire an album using the configured behavior matrix
     * Routes to Soulseek or Lidarr based on settings, with fallback support
     * Queued to enable parallel album acquisition
     *
     * @param request - Album to acquire
     * @param context - Tracking context (userId, batchId, etc.)
     * @returns Acquisition result
     */
    async acquireAlbum(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        return this.albumQueue.add(() =>
            this.acquireAlbumInternal(request, context)
        );
    }

    /**
     * Internal album acquisition logic (called via queue)
     */
    private async acquireAlbumInternal(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        logger.debug(
            `\n[Acquisition] Acquiring album: ${request.artistName} - ${request.albumTitle} (queue: ${this.albumQueue.size} pending, ${this.albumQueue.pending} active)`
        );

        // Verify artist name before acquisition
        try {
            const correction = await lastFmService.getArtistCorrection(
                request.artistName
            );
            if (correction?.corrected) {
                logger.debug(
                    `[Acquisition] Artist corrected: "${request.artistName}" → "${correction.canonicalName}"`
                );
                request = { ...request, artistName: correction.canonicalName };
            }
        } catch (error) {
            logger.warn(
                `[Acquisition] Artist correction failed for "${request.artistName}":`,
                error
            );
        }

        // Get download behavior configuration
        const behavior = await this.getDownloadBehavior();

        // Validate at least one source is available
        if (!behavior.hasPrimarySource) {
            const error =
                "No download sources available (neither Soulseek nor Lidarr configured)";
            logger.error(`[Acquisition] ${error}`);
            return { success: false, error };
        }

        // Try primary source first
        let result: AcquisitionResult;

        if (behavior.primarySource === "soulseek") {
            logger.debug(`[Acquisition] Trying primary: Soulseek`);
            result = await this.acquireAlbumViaSoulseek(request, context);

            // Fallback to Lidarr if Soulseek fails and fallback is configured
            if (!result.success) {
                logger.debug(
                    `[Acquisition] Soulseek failed: ${result.error || "unknown error"}`
                );
                logger.debug(
                    `[Acquisition] Fallback available: hasFallback=${behavior.hasFallbackSource}, source=${behavior.fallbackSource}`
                );

                if (
                    behavior.hasFallbackSource &&
                    behavior.fallbackSource === "lidarr"
                ) {
                    logger.debug(
                        `[Acquisition] Attempting Lidarr fallback...`
                    );
                    result = await this.acquireAlbumViaLidarr(request, context);
                } else {
                    logger.debug(
                        `[Acquisition] No fallback configured or fallback not Lidarr`
                    );
                }
            }
        } else if (behavior.primarySource === "lidarr") {
            logger.debug(`[Acquisition] Trying primary: Lidarr`);
            result = await this.acquireAlbumViaLidarr(request, context);

            // Fallback to Soulseek if Lidarr fails and fallback is configured
            if (!result.success) {
                logger.debug(
                    `[Acquisition] Lidarr failed: ${result.error || "unknown error"}`
                );
                logger.debug(
                    `[Acquisition] Fallback available: hasFallback=${behavior.hasFallbackSource}, source=${behavior.fallbackSource}`
                );

                if (
                    behavior.hasFallbackSource &&
                    behavior.fallbackSource === "soulseek"
                ) {
                    logger.debug(
                        `[Acquisition] Attempting Soulseek fallback...`
                    );
                    result = await this.acquireAlbumViaSoulseek(request, context);
                } else {
                    logger.debug(
                        `[Acquisition] No fallback configured or fallback not Soulseek`
                    );
                }
            }
        } else {
            // This should never happen due to validation above
            const error = "No primary source configured";
            logger.error(`[Acquisition] ${error}`);
            return { success: false, error };
        }

        return result;
    }

    /**
     * Acquire individual tracks via Soulseek (for Unknown Album case)
     * Batch downloads tracks without album MBID
     *
     * @param requests - Tracks to acquire
     * @param context - Tracking context
     * @returns Array of acquisition results
     */
    async acquireTracks(
        requests: TrackAcquisitionRequest[],
        context: AcquisitionContext
    ): Promise<AcquisitionResult[]> {
        logger.debug(
            `\n[Acquisition] Acquiring ${requests.length} individual tracks via Soulseek`
        );

        // Check Soulseek availability
        const soulseekAvailable = await soulseekService.isAvailable();
        if (!soulseekAvailable) {
            logger.error(
                `[Acquisition] Soulseek not available for track downloads`
            );
            return requests.map(() => ({
                success: false,
                error: "Soulseek not configured",
            }));
        }

        // Get music path
        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;
        if (!musicPath) {
            logger.error(`[Acquisition] Music path not configured`);
            return requests.map(() => ({
                success: false,
                error: "Music path not configured",
            }));
        }

        // Prepare tracks for batch download
        const tracksToDownload = requests.map((req) => ({
            artist: req.artistName,
            title: req.trackTitle,
            album: req.albumTitle || "Unknown Album",
        }));

        try {
            // Use Soulseek batch download
            const batchResult = await soulseekService.searchAndDownloadBatch(
                tracksToDownload,
                musicPath,
                settings?.soulseekConcurrentDownloads || 4 // concurrency
            );

            logger.debug(
                `[Acquisition] Batch result: ${batchResult.successful}/${requests.length} tracks downloaded`
            );

            // Create individual results for each track
            const results: AcquisitionResult[] = requests.map((req, index) => {
                // Check if this track was in the successful list
                // Note: We don't have per-track success info from batch, so we estimate
                const success = index < batchResult.successful;
                return {
                    success,
                    source: "soulseek" as const,
                    tracksDownloaded: success ? 1 : 0,
                    tracksTotal: 1,
                    error: success
                        ? undefined
                        : batchResult.errors[index] || "Download failed",
                };
            });

            return results;
        } catch (error: any) {
            logger.error(
                `[Acquisition] Batch track download error: ${error.message}`
            );
            return requests.map(() => ({
                success: false,
                error: error.message,
            }));
        }
    }

    /**
     * Acquire album via Soulseek (track-by-track download)
     * Gets track list from MusicBrainz or Last.fm, then batch downloads
     * Marks job as completed immediately (no webhook needed)
     *
     * @param request - Album to acquire
     * @param context - Tracking context
     * @returns Acquisition result
     */
    private async acquireAlbumViaSoulseek(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        logger.debug(
            `[Acquisition/Soulseek] Downloading: ${request.artistName} - ${request.albumTitle}`
        );

        // Get music path
        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;
        if (!musicPath) {
            return { success: false, error: "Music path not configured" };
        }

        if (!request.mbid) {
            return {
                success: false,
                error: "Album MBID required for Soulseek download",
            };
        }

        let job: any;
        try {
            // Create download job at start for tracking
            job = await this.createDownloadJob(request, context);

            // Calculate attempt number (existing soulseek attempts + 1)
            const jobMetadata = (job.metadata as any) || {};
            const soulseekAttempts = (jobMetadata.soulseekAttempts || 0) + 1;
            await this.updateJobStatusText(
                job.id,
                "soulseek",
                soulseekAttempts
            );

            let tracks: Array<{ title: string; position?: number }>;

            // If specific tracks requested, use those instead of full album
            if (request.requestedTracks && request.requestedTracks.length > 0) {
                tracks = request.requestedTracks;
                logger.debug(
                    `[Acquisition/Soulseek] Using ${tracks.length} requested tracks (not full album)`
                );
            } else {
                // Strategy 1: Get track list from MusicBrainz
                tracks = await musicBrainzService.getAlbumTracks(request.mbid);

                // Strategy 2: Fallback to Last.fm (always try when MusicBrainz fails)
                if (!tracks || tracks.length === 0) {
                    logger.debug(
                        `[Acquisition/Soulseek] MusicBrainz has no tracks, trying Last.fm`
                    );

                    try {
                        const albumInfo = await lastFmService.getAlbumInfo(
                            request.artistName,
                            request.albumTitle
                        );
                        const lastFmTracks = albumInfo?.tracks?.track || [];

                        if (Array.isArray(lastFmTracks) && lastFmTracks.length > 0) {
                            tracks = lastFmTracks.map((t: any) => ({
                                title: t.name || t.title,
                                position: t["@attr"]?.rank
                                    ? parseInt(t["@attr"].rank)
                                    : undefined,
                            }));
                            logger.debug(
                                `[Acquisition/Soulseek] Got ${tracks.length} tracks from Last.fm`
                            );
                        }
                    } catch (lastfmError: any) {
                        logger.warn(
                            `[Acquisition/Soulseek] Last.fm fallback failed: ${lastfmError.message}`
                        );
                    }
                }

                if (!tracks || tracks.length === 0) {
                    // Mark job as failed
                    await this.updateJobStatus(
                        job.id,
                        "failed",
                        "Could not get track list from MusicBrainz or Last.fm"
                    );
                    return {
                        success: false,
                        error: "Could not get track list from MusicBrainz or Last.fm",
                    };
                }

                logger.debug(
                    `[Acquisition/Soulseek] Found ${tracks.length} tracks for album`
                );
            }

            // Prepare tracks for batch download
            const tracksToDownload = tracks.map((track) => ({
                artist: request.artistName,
                title: track.title,
                album: request.albumTitle,
            }));

            // Use Soulseek batch download (parallel with concurrency limit)
            const batchResult = await soulseekService.searchAndDownloadBatch(
                tracksToDownload,
                musicPath,
                settings?.soulseekConcurrentDownloads || 4 // concurrency
            );

            if (batchResult.successful === 0) {
                // Mark job as failed
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    `No tracks found on Soulseek (searched ${tracks.length} tracks)`
                );
                return {
                    success: false,
                    tracksTotal: tracks.length,
                    downloadJobId: parseInt(job.id),
                    error: `No tracks found on Soulseek (searched ${tracks.length} tracks)`,
                };
            }

            // Success threshold: at least 50% of tracks
            const successThreshold = Math.ceil(tracks.length * 0.5);
            const isSuccess = batchResult.successful >= successThreshold;

            logger.debug(
                `[Acquisition/Soulseek] Downloaded ${batchResult.successful}/${tracks.length} tracks (threshold: ${successThreshold})`
            );

            // Mark job as completed immediately (Soulseek doesn't use webhooks)
            await this.updateJobStatus(
                job.id,
                isSuccess ? "completed" : "failed",
                isSuccess
                    ? undefined
                    : `Only ${batchResult.successful}/${tracks.length} tracks found`
            );

            // Update job metadata with track counts
            await prisma.downloadJob.update({
                where: { id: job.id },
                data: {
                    metadata: {
                        ...job.metadata,
                        tracksDownloaded: batchResult.successful,
                        tracksTotal: tracks.length,
                    },
                },
            });

            return {
                success: isSuccess,
                source: "soulseek",
                downloadJobId: parseInt(job.id),
                tracksDownloaded: batchResult.successful,
                tracksTotal: tracks.length,
                error: isSuccess
                    ? undefined
                    : `Only ${batchResult.successful}/${tracks.length} tracks found`,
            };
        } catch (error: any) {
            logger.error(`[Acquisition/Soulseek] Error: ${error.message}`);
            // Update job status if job was created
            if (job) {
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    error.message
                ).catch((e) =>
                    logger.error(
                        `[Acquisition/Soulseek] Failed to update job status: ${e.message}`
                    )
                );
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * Acquire album via Lidarr (full album download)
     * Creates download job and waits for webhook completion
     *
     * @param request - Album to acquire
     * @param context - Tracking context
     * @returns Acquisition result
     */
    private async acquireAlbumViaLidarr(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        logger.debug(
            `[Acquisition/Lidarr] Downloading: ${request.artistName} - ${request.albumTitle}`
        );

        if (!request.mbid) {
            return {
                success: false,
                error: "Album MBID required for Lidarr download",
            };
        }

        let job: any;
        try {
            // Create download job
            job = await this.createDownloadJob(request, context);

            // Calculate attempt number (existing lidarr attempts + 1)
            const jobMetadata = (job.metadata as any) || {};
            const lidarrAttempts = (jobMetadata.lidarrAttempts || 0) + 1;
            await this.updateJobStatusText(job.id, "lidarr", lidarrAttempts);

            // Start Lidarr download
            const isDiscovery = !!context.discoveryBatchId;
            const result = await simpleDownloadManager.startDownload(
                job.id,
                request.artistName,
                request.albumTitle,
                request.mbid,
                context.userId,
                isDiscovery
            );

            if (result.success) {
                logger.debug(
                    `[Acquisition/Lidarr] Download started (correlation: ${result.correlationId})`
                );

                return {
                    success: true,
                    source: "lidarr",
                    downloadJobId: parseInt(job.id),
                    correlationId: result.correlationId,
                };
            } else {
                logger.error(
                    `[Acquisition/Lidarr] Failed to start: ${result.error}`
                );

                // Mark job as failed
                await this.updateJobStatus(job.id, "failed", result.error);

                // Return structured error info for fallback logic
                return {
                    success: false,
                    error: result.error,
                    errorType: result.errorType,
                    isRecoverable: result.isRecoverable,
                };
            }
        } catch (error: any) {
            logger.error(`[Acquisition/Lidarr] Error: ${error.message}`);
            // Update job status if job was created
            if (job) {
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    error.message
                ).catch((e) =>
                    logger.error(
                        `[Acquisition/Lidarr] Failed to update job status: ${e.message}`
                    )
                );
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * Create a DownloadJob for tracking acquisition
     * Links to Discovery batch or Spotify import job as appropriate
     *
     * @param request - Album request
     * @param context - Tracking context
     * @returns Created download job
     */
    private async createDownloadJob(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<any> {
        // Check for existing job first
        if (context.existingJobId) {
            logger.debug(
                `[Acquisition] Using existing download job: ${context.existingJobId}`
            );
            return { id: context.existingJobId };
        }

        // Validate userId before creating download job to prevent foreign key constraint violations
        if (!context.userId || typeof context.userId !== 'string' || context.userId === 'NaN' || context.userId === 'undefined' || context.userId === 'null') {
            logger.error(
                `[Acquisition] Invalid userId in context: ${JSON.stringify({
                    userId: context.userId,
                    typeofUserId: typeof context.userId,
                    albumTitle: request.albumTitle,
                    artistName: request.artistName
                })}`
            );
            throw new Error(`Invalid userId in acquisition context: ${context.userId}`);
        }

        const jobData: any = {
            userId: context.userId,
            subject: `${request.artistName} - ${request.albumTitle}`,
            type: "album",
            targetMbid: request.mbid || null,
            status: "pending",
            metadata: {
                artistName: request.artistName,
                albumTitle: request.albumTitle,
                albumMbid: request.mbid,
            },
        };

        // Add context-based tracking
        if (context.discoveryBatchId) {
            jobData.discoveryBatchId = context.discoveryBatchId;
            jobData.metadata.downloadType = "discovery";
        }

        if (context.spotifyImportJobId) {
            jobData.metadata.spotifyImportJobId = context.spotifyImportJobId;
            jobData.metadata.downloadType = "spotify_import";
        }

        const job = await prisma.downloadJob.create({
            data: jobData,
        });

        logger.debug(
            `[Acquisition] Created download job: ${job.id} (type: ${
                jobData.metadata.downloadType || "library"
            })`
        );

        return job;
    }

    /**
     * Update download job status
     *
     * @param jobId - Job ID to update
     * @param status - New status
     * @param error - Optional error message
     */
    private async updateJobStatus(
        jobId: string,
        status: string,
        error?: string
    ): Promise<void> {
        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                status,
                error: error || null,
                completedAt:
                    status === "completed" || status === "failed"
                        ? new Date()
                        : undefined,
            },
        });

        logger.debug(
            `[Acquisition] Updated job ${jobId}: status=${status}${
                error ? `, error=${error}` : ""
            }`
        );
    }
}

// Export singleton instance
export const acquisitionService = new AcquisitionService();
