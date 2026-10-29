/**
 * Album and track acquisition for Discovery Weekly and playlist import: download source
 * selection, behavior matrix routing and job tracking.
 */

import { logger } from "../utils/logger";
import { config } from "../config";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import { soulseekService } from "./soulseek";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { musicBrainzService } from "./musicbrainz";
import { isLidarrConfigured } from "./lidarrClient";
import { failureCause } from "../utils/outcome";
import { getArtistCorrection } from "./artistCorrection";
import { isMbid } from "./artistIdentity";
import { AcquisitionErrorType } from "./lidarr";
import { distributedLock } from "../utils/distributedLock";
import PQueue from "p-queue";
import { downloadJobsTotal, downloadJobDuration } from "../utils/metrics";
import {
  UserFacingError,
  IntegrationError,
  ConfigurationError,
} from '../utils/errors';

/** Where an acquisition came from (Discovery batch or Spotify import), for linking its download jobs. */
interface AcquisitionContext {
    userId: string;
    discoveryBatchId?: string;
    spotifyImportJobId?: string;
    existingJobId?: string;
    retryCount?: number;
    signal?: AbortSignal;
}

interface AlbumAcquisitionRequest {
    albumTitle: string;
    artistName: string;
    mbid?: string;
    requestedTracks?: Array<{ title: string; position?: number }>;
}

interface TrackAcquisitionRequest {
    trackTitle: string;
    artistName: string;
    albumTitle?: string;
}

interface AcquisitionResult {
    success: boolean;
    downloadJobId?: string;
    source?: "soulseek" | "lidarr";
    error?: string;
    errorType?: AcquisitionErrorType;
    isRecoverable?: boolean;
    tracksDownloaded?: number;
    tracksTotal?: number;
    correlationId?: string;
}

interface DownloadBehavior {
    hasPrimarySource: boolean;
    primarySource: "soulseek" | "lidarr" | null;
    hasFallbackSource: boolean;
    fallbackSource: "soulseek" | "lidarr" | null;
}

class AcquisitionService {
    private albumQueue: PQueue;
    private lastConcurrency: number = 4;

    constructor() {
        this.albumQueue = new PQueue({ concurrency: 4 });
        logger.debug(
            "[Acquisition] Initialized album queue with default concurrency=4"
        );
    }

    /** Applies the user's concurrency setting to the album queue before it is used. */
    private async updateQueueConcurrency(): Promise<void> {
        const settings = await getSystemSettings();
        const concurrency = settings?.soulseekConcurrentDownloads ?? 1;

        if (concurrency !== this.lastConcurrency) {
            this.albumQueue.concurrency = concurrency;
            this.lastConcurrency = concurrency;
            logger.debug(
                `[Acquisition] Updated album queue concurrency to ${concurrency}`
            );
        }
    }

    /** Picks the download source from the user's settings and which services are actually available. */
    private async getDownloadBehavior(): Promise<DownloadBehavior> {
        const settings = await getSystemSettings();

        const downloadSource =
            settings?.downloadSource === "lidarr" ? "lidarr" : "soulseek";
        const primaryFailureFallback = settings?.primaryFailureFallback;

        const hasSoulseek = await soulseekService.isAvailable();
        const hasLidarr = isLidarrConfigured(settings);

        // Case 1: No sources available
        if (!hasSoulseek && !hasLidarr) {
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
            logger.debug("[Acquisition] Source config: primary=soulseek, fallback=none (only source)");
            return {
                hasPrimarySource: true,
                primarySource: "soulseek",
                hasFallbackSource: false,
                fallbackSource: null,
            };
        }

        if (hasLidarr && !hasSoulseek) {
            logger.debug("[Acquisition] Source config: primary=lidarr, fallback=none (only source)");
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

        // Only auto-enable fallback if the setting is truly undefined/null (first-time users)
        // "none" is the explicit "skip track" choice and stays off
        if (!useFallback && (primaryFailureFallback === undefined || primaryFailureFallback === null)) {
            useFallback = true;
            logger.debug(
                `[Acquisition] Auto-enabled fallback: ${alternative} (both sources configured)`
            );
        }

        logger.debug(
            `[Acquisition] Source config: primary=${userPrimary}, fallback=${useFallback ? alternative : "none"}`
        );

        return {
            hasPrimarySource: true,
            primarySource: userPrimary,
            hasFallbackSource: useFallback,
            fallbackSource: useFallback ? alternative : null,
        };
    }

    /** Stores source-specific status text in the job's metadata for the frontend. */
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
     * With an album id, the release group's own credit names the artist; a name
     * guess is used only when there is no id to read it from.
     */
    private async canonicalArtistName(request: AlbumAcquisitionRequest): Promise<string> {
        if (request.mbid && isMbid(request.mbid)) {
            const group = await musicBrainzService.getReleaseGroup(request.mbid);
            if (group.kind === "answered") {
                return group.value?.["artist-credit"]?.[0]?.artist?.name ?? request.artistName;
            }
            logger.warn(`[Acquisition] Release group ${request.mbid}: ${group.kind === "absent" ? "not on MusicBrainz" : failureCause(group)}`);
            return request.artistName;
        }
        try {
            const correction = await getArtistCorrection(request.artistName);
            return correction?.corrected ? correction.canonicalName : request.artistName;
        } catch (error) {
            logger.warn(`[Acquisition] Artist correction failed for "${request.artistName}":`, error);
            return request.artistName;
        }
    }

    /** Acquire an album from Soulseek or Lidarr per the user's settings, with fallback; queued so albums run in parallel. */
    async acquireAlbum(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        await this.updateQueueConcurrency();

        // Timeout is applied INSIDE the queue callback so it only counts
        // actual processing time, not time spent waiting for a queue slot.
        const MAX_ACQUISITION_TIME = 5 * 60 * 1000; // 5 minutes
        const result = await this.albumQueue.add(async () => {
            if (context.signal?.aborted) {
                return { success: false, error: 'Import cancelled' } as AcquisitionResult;
            }

            let timeoutId: NodeJS.Timeout;
            const timeoutPromise = new Promise<AcquisitionResult>((resolve) => {
                timeoutId = setTimeout(() => {
                    resolve({
                        success: false,
                        source: undefined,
                        error: `Acquisition timed out after ${Math.round(MAX_ACQUISITION_TIME / 1000)}s - tried all available sources`,
                    });
                }, MAX_ACQUISITION_TIME);
            });

            try {
                return await Promise.race([
                    this.acquireAlbumInternal(request, context),
                    timeoutPromise,
                ]);
            } finally {
                clearTimeout(timeoutId!);
            }
        }, context.signal ? { signal: context.signal } : {});

        return result as AcquisitionResult;
    }

    /** The queued body of acquireAlbum. */
    private async acquireAlbumInternal(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        if (context.signal?.aborted) {
            return { success: false, error: 'Import cancelled' };
        }

        const startTime = Date.now();
        logger.debug(
            `\n[Acquisition] Acquiring album: ${request.artistName} - ${request.albumTitle} (queue: ${this.albumQueue.size} pending, ${this.albumQueue.pending} active)`
        );

        const soulseekAvailable = await soulseekService.isAvailable();
        const settings = await getSystemSettings();
        const lidarrAvailable = isLidarrConfigured(settings);

        if (!soulseekAvailable && !lidarrAvailable) {
            throw new ConfigurationError(
                'No download sources configured. Please configure Soulseek or Lidarr in settings.'
            );
        }

        // MBID only required when Soulseek is unavailable (Lidarr needs it)
        if (!request.mbid && !soulseekAvailable) {
            throw new UserFacingError('Album MBID is required when Soulseek is not available', 400, 'INVALID_INPUT');
        }

        const artistName = await this.canonicalArtistName(request);
        if (artistName !== request.artistName) {
            logger.debug(`[Acquisition] Artist corrected: "${request.artistName}" → "${artistName}"`);
            request = { ...request, artistName };
        }

        const behavior = await this.getDownloadBehavior();

        let result: AcquisitionResult;

        try {
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
                        behavior.fallbackSource === "lidarr" &&
                        request.mbid
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
                if (!request.mbid) {
                    // No MBID -- Lidarr requires it, skip directly to Soulseek
                    logger.info(`[Acquisition] No MBID for "${request.albumTitle}", skipping Lidarr, trying Soulseek directly`);
                    result = await this.acquireAlbumViaSoulseek(request, context);
                } else {
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
                }
            } else {
                // This should never happen due to validation above
                throw new ConfigurationError("No primary source configured");
            }
        } catch (error) {
            if (error instanceof IntegrationError && error.retryable) {
                const currentRetryCount = context.retryCount || 0;
                const maxRetries = 3;

                if (currentRetryCount < maxRetries) {
                    logger.info(`Retrying download for ${request.mbid} due to retryable error (attempt ${currentRetryCount + 1}/${maxRetries})`);
                    return await this.acquireAlbumInternal(request, { ...context, retryCount: currentRetryCount + 1 });
                } else {
                    logger.error(`Max retries (${maxRetries}) exceeded for ${request.mbid}`);
                    throw new IntegrationError(
                        `Failed after ${maxRetries} retry attempts`,
                        error.integration,
                        false
                    );
                }
            }
            throw error;
        }

        const duration = (Date.now() - startTime) / 1000;
        const source = result.source || 'unknown';
        const status = result.success ? 'success' : 'failed';

        downloadJobsTotal.inc({ source, status });
        downloadJobDuration.observe({ source, status }, duration);

        return result;
    }

    /** Acquire individual tracks via Soulseek, for tracks with no album MBID. */
    async acquireTracks(
        requests: TrackAcquisitionRequest[],
        context: AcquisitionContext
    ): Promise<AcquisitionResult[]> {
        logger.debug(
            `\n[Acquisition] Acquiring ${requests.length} individual tracks via Soulseek`
        );

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

        const settings = await getSystemSettings();
        const musicPath = config.music.musicPath;

        const tracksToDownload = requests.map((req) => ({
            artist: req.artistName,
            title: req.trackTitle,
            album: req.albumTitle || "Unknown Album",
        }));

        try {
            const batchResult = await soulseekService.searchAndDownloadBatch(
                tracksToDownload,
                musicPath,
                settings?.soulseekConcurrentDownloads ?? 4, // concurrency
                context.signal
            );

            logger.debug(
                `[Acquisition] Batch result: ${batchResult.successful}/${requests.length} tracks downloaded`
            );

            // Note: Batch doesn't return per-track success mapping, so we use error messages to determine failures
            const results: AcquisitionResult[] = requests.map((req) => {
                const trackKey = `${req.artistName} - ${req.trackTitle}`;
                const trackError = batchResult.errors.find((e) =>
                    e.startsWith(trackKey)
                );
                const success = !trackError;

                return {
                    success,
                    source: "soulseek" as const,
                    tracksDownloaded: success ? 1 : 0,
                    tracksTotal: 1,
                    error: trackError || undefined,
                };
            });

            return results;
        } catch (error: any) {
            if (error?.name === 'AbortError' || context.signal?.aborted) {
                return requests.map(() => ({
                    success: false,
                    error: 'Import cancelled',
                }));
            }
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
     * Acquire an album via Soulseek track by track, using MusicBrainz for the
     * track list. The job completes inline, with no webhook.
     */
    private async acquireAlbumViaSoulseek(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        logger.debug(
            `[Acquisition/Soulseek] Downloading: ${request.artistName} - ${request.albumTitle}`
        );

        const musicPath = config.music.musicPath;

        if (!request.mbid && (!request.requestedTracks || request.requestedTracks.length === 0)) {
            return {
                success: false,
                error: "Album MBID or track list required for Soulseek download",
            };
        }

        let job: any;
        try {
            job = await this.createDownloadJob(request, context);

            const jobMetadata = (job.metadata as any) || {};
            const soulseekAttempts = (jobMetadata.soulseekAttempts || 0) + 1;
            await this.updateJobStatusText(
                job.id,
                "soulseek",
                soulseekAttempts
            );

            let tracks: Array<{ title: string; position?: number }>;

            if (request.requestedTracks && request.requestedTracks.length > 0) {
                tracks = request.requestedTracks;
                logger.debug(
                    `[Acquisition/Soulseek] Using ${tracks.length} requested tracks (not full album)`
                );
            } else {
                // The track list comes from MusicBrainz; mbid is guaranteed by the guard above
                const mbTracks = await musicBrainzService.getAlbumCatalogue(request.mbid!);
                if (mbTracks.kind === "answered") {
                    tracks = mbTracks.value.recordings.map((rec) => ({
                        title: rec.title,
                        position: rec.position ?? undefined,
                    }));
                } else if (mbTracks.kind === "absent") {
                    logger.debug(
                        `[Acquisition/Soulseek] MusicBrainz has no tracks; no fallback source`
                    );
                    await this.updateJobStatus(
                        job.id,
                        "failed",
                        "Could not get track list from MusicBrainz"
                    );
                    return {
                        success: false,
                        error: "Could not get track list from MusicBrainz",
                    };
                } else {
                    // A failed lookup must not look like "the album has no
                    // tracks": the job fails with the real cause.
                    const cause = failureCause(mbTracks);
                    await this.updateJobStatus(job.id, "failed", `Track list lookup failed: ${cause}`);
                    return {
                        success: false,
                        error: `Track list lookup failed: ${cause}`,
                    };
                }

                logger.debug(
                    `[Acquisition/Soulseek] Found ${tracks.length} tracks for album`
                );
            }

            // One album-level search (1-2 network calls) rather than one per track
            const batchResult = await soulseekService.searchAndDownloadAlbum(
                request.artistName,
                request.albumTitle,
                tracks,
                musicPath,
                context.signal
            );

            if (batchResult.successful === 0) {
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    `No tracks found on Soulseek (searched ${tracks.length} tracks)`
                );
                return {
                    success: false,
                    tracksTotal: tracks.length,
                    downloadJobId: job.id,
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

            // Read current metadata from DB (job object may be a stub with only id)
            const currentJob = await prisma.downloadJob.findUnique({
                where: { id: job.id },
                select: { metadata: true },
            });
            await prisma.downloadJob.update({
                where: { id: job.id },
                data: {
                    metadata: {
                        ...((currentJob?.metadata as any) || {}),
                        tracksDownloaded: batchResult.successful,
                        tracksTotal: tracks.length,
                    },
                },
            });

            return {
                success: isSuccess,
                source: "soulseek",
                downloadJobId: job.id,
                tracksDownloaded: batchResult.successful,
                tracksTotal: tracks.length,
                error: isSuccess
                    ? undefined
                    : `Only ${batchResult.successful}/${tracks.length} tracks found`,
            };
        } catch (error: any) {
            if (error?.name === 'AbortError' || context.signal?.aborted) {
                if (job) {
                    await this.updateJobStatus(job.id, "failed", "Import cancelled").catch(() => {});
                }
                return { success: false, error: 'Import cancelled' };
            }
            logger.error(`[Acquisition/Soulseek] Error: ${error.message}`);
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

    /** Acquire an album via Lidarr; the job completes when its webhook arrives. */
    private async acquireAlbumViaLidarr(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        if (context.signal?.aborted) {
            return { success: false, error: 'Import cancelled' };
        }

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
            job = await this.createDownloadJob(request, context);

            const jobMetadata = (job.metadata as any) || {};
            const lidarrAttempts = (jobMetadata.lidarrAttempts || 0) + 1;
            await this.updateJobStatusText(job.id, "lidarr", lidarrAttempts);

            const isDiscovery = !!context.discoveryBatchId;
            const result = await simpleDownloadManager.startDownload(
                job.id,
                request.artistName,
                request.albumTitle,
                request.mbid,
                isDiscovery
            );

            if (result.success) {
                logger.debug(
                    `[Acquisition/Lidarr] Download started (correlation: ${result.correlationId})`
                );

                return {
                    success: true,
                    source: "lidarr",
                    downloadJobId: job.id,
                    correlationId: result.correlationId,
                };
            } else {
                logger.error(
                    `[Acquisition/Lidarr] Failed to start: ${result.error}`
                );

                await this.updateJobStatus(job.id, "failed", result.error);

                return {
                    success: false,
                    error: result.error,
                    errorType: result.errorType,
                    isRecoverable: result.isRecoverable,
                };
            }
        } catch (error: any) {
            logger.error(`[Acquisition/Lidarr] Error: ${error.message}`);
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

    /** Create the DownloadJob for an acquisition, linked to its batch or import, reusing an existing job for the same album. */
    private async createDownloadJob(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<any> {
        // Check for existing job first - return full object (not stub) to preserve metadata
        if (context.existingJobId) {
            logger.debug(
                `[Acquisition] Using existing download job: ${context.existingJobId}`
            );
            const existingJob = await prisma.downloadJob.findUnique({
                where: { id: context.existingJobId },
            });
            if (existingJob) return existingJob;
            return { id: context.existingJobId };
        }

        return (await this.findOrCreateDownloadJob(request, context)).job;
    }

    /**
     * The listener's pending or running job for this album (in this Discover batch, or outside Discover), or a new one;
     * `created` says which. With an album id, the active-album unique index decides a race: the losing create takes
     * the winner's job. By name only, a lock does.
     */
    async findOrCreateDownloadJob(
        request: Pick<AlbumAcquisitionRequest, "artistName" | "albumTitle" | "mbid">,
        context: Pick<AcquisitionContext, "userId" | "discoveryBatchId" | "spotifyImportJobId">
    ): Promise<{ job: any; created: boolean }> {
        const dedupKey = request.mbid || `${request.artistName}::${request.albumTitle}`;

        const existingJobWhere: any = {
            userId: context.userId,
            discoveryBatchId: context.discoveryBatchId || null,
            status: { in: ['pending', 'processing'] },
        };
        if (request.mbid) {
            existingJobWhere.targetMbid = request.mbid;
        } else {
            existingJobWhere.subject = `${request.artistName} - ${request.albumTitle}`;
        }

        const existingJob = await prisma.downloadJob.findFirst({
            where: existingJobWhere,
        });
        if (existingJob) {
            logger.info(
                `[Acquisition] Download job already exists for album ${dedupKey}, returning existing job ${existingJob.id}`
            );
            return { job: existingJob, created: false };
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
                albumMbid: request.mbid || null,
            },
        };
        if (context.discoveryBatchId) {
            jobData.discoveryBatchId = context.discoveryBatchId;
            jobData.metadata.downloadType = "discovery";
        }
        if (context.spotifyImportJobId) {
            jobData.metadata.spotifyImportJobId = context.spotifyImportJobId;
            jobData.metadata.downloadType = "spotify_import";
        }
        const create = async () => {
            const job = await prisma.downloadJob.create({ data: jobData });
            logger.debug(
                `[Acquisition] Created download job: ${job.id} (type: ${jobData.metadata.downloadType || "library"})`
            );
            return { job, created: true };
        };

        if (request.mbid) {
            try {
                return await create();
            } catch (error: any) {
                if (error?.code !== "P2002") throw error;
                const winner = await prisma.downloadJob.findFirst({ where: existingJobWhere });
                if (!winner) throw error;
                return { job: winner, created: false };
            }
        }

        const lockKey = `download-job:${context.userId}:${dedupKey}:${context.discoveryBatchId || 'null'}`;
        return await distributedLock.withLock(lockKey, 5000, async () => {
            // Another request may have made it while this one waited for the lock.
            const doubleCheck = await prisma.downloadJob.findFirst({
                where: existingJobWhere,
            });
            if (doubleCheck) return { job: doubleCheck, created: false };
            return create();
        });
    }

    /** Updates a download job's status, recording the error message when given. */
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
