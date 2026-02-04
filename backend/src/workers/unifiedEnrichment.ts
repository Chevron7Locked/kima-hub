/**
 * Unified Enrichment Worker
 *
 * Handles ALL enrichment in one place:
 * - Artist metadata (Last.fm, MusicBrainz)
 * - Track mood tags (Last.fm)
 * - Audio analysis (triggers Essentia via Redis queue)
 *
 * Two modes:
 * 1. FULL: Re-enriches everything regardless of status (Settings > Enrich)
 * 2. INCREMENTAL: Only new material and incomplete items (Sync)
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { enrichSimilarArtist } from "./artistEnrichment";
import { lastFmService } from "../services/lastfm";
import Redis from "ioredis";
import { config } from "../config";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { audioAnalysisCleanupService } from "../services/audioAnalysisCleanup";
import { rateLimiter } from "../services/rateLimiter";
import { vibeAnalysisCleanupService } from "../services/vibeAnalysisCleanup";
import { getSystemSettings } from "../utils/systemSettings";
import { featureDetection } from "../services/featureDetection";
import pLimit from "p-limit";

// Configuration
const ARTIST_BATCH_SIZE = 10;
const TRACK_BATCH_SIZE = 20;
const ENRICHMENT_INTERVAL_MS = 30 * 1000; // 30 seconds
const MAX_CONSECUTIVE_SYSTEM_FAILURES = 5; // Circuit breaker threshold

let isRunning = false;
let enrichmentInterval: NodeJS.Timeout | null = null;
let redis: Redis | null = null;
let controlSubscriber: Redis | null = null;
let isPaused = false;
let isStopping = false;
let immediateEnrichmentRequested = false;
let consecutiveSystemFailures = 0; // Track consecutive system-level failures
let lastRunTime = 0;
const MIN_INTERVAL_MS = 10000; // Minimum 10s between cycles

// Batch failure tracking
interface BatchFailures {
    artists: { name: string; error: string }[];
    tracks: { name: string; error: string }[];
    audio: { name: string; error: string }[];
}
let currentBatchFailures: BatchFailures = {
    artists: [],
    tracks: [],
    audio: [],
};

// Mood tags to extract from Last.fm
const MOOD_TAGS = new Set([
    // Energy/Activity
    "chill",
    "relax",
    "relaxing",
    "calm",
    "peaceful",
    "ambient",
    "energetic",
    "upbeat",
    "hype",
    "party",
    "dance",
    "workout",
    "gym",
    "running",
    "exercise",
    "motivation",
    // Emotions
    "sad",
    "melancholy",
    "melancholic",
    "depressing",
    "heartbreak",
    "happy",
    "feel good",
    "feel-good",
    "joyful",
    "uplifting",
    "angry",
    "aggressive",
    "intense",
    "romantic",
    "love",
    "sensual",
    // Time/Setting
    "night",
    "late night",
    "evening",
    "morning",
    "summer",
    "winter",
    "rainy",
    "sunny",
    "driving",
    "road trip",
    "travel",
    // Activity
    "study",
    "focus",
    "concentration",
    "work",
    "sleep",
    "sleeping",
    "bedtime",
    // Vibe
    "dreamy",
    "atmospheric",
    "ethereal",
    "spacey",
    "groovy",
    "funky",
    "smooth",
    "dark",
    "moody",
    "brooding",
    "epic",
    "cinematic",
    "dramatic",
    "nostalgic",
    "throwback",
]);

/**
 * Timeout wrapper to prevent operations from hanging indefinitely
 * If an operation takes longer than the timeout, it will fail and move to the next item
 */
async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]);
}

/**
 * Filter tags to only include mood-relevant ones
 */
function filterMoodTags(tags: string[]): string[] {
    return tags
        .map((t) => t.toLowerCase().trim())
        .filter((t) => {
            if (MOOD_TAGS.has(t)) return true;
            for (const mood of MOOD_TAGS) {
                if (t.includes(mood) || mood.includes(t)) return true;
            }
            return false;
        })
        .slice(0, 10);
}

/**
 * Initialize Redis connection for audio analysis queue
 */
function getRedis(): Redis {
    if (!redis) {
        redis = new Redis(config.redisUrl);
    }
    return redis;
}

/**
 * Setup subscription to enrichment control channel
 */
async function setupControlChannel() {
    if (!controlSubscriber) {
        controlSubscriber = new Redis(config.redisUrl);
        await controlSubscriber.subscribe("enrichment:control");

        controlSubscriber.on("message", (channel, message) => {
            if (channel === "enrichment:control") {
                logger.debug(
                    `[Enrichment] Received control message: ${message}`,
                );

                if (message === "pause") {
                    isPaused = true;
                    logger.debug("[Enrichment] Paused");
                } else if (message === "resume") {
                    isPaused = false;
                    logger.debug("[Enrichment] Resumed");
                } else if (message === "stop") {
                    isStopping = true;
                    isPaused = true;
                    logger.debug(
                        "[Enrichment] Stopping gracefully - completing current item...",
                    );
                    // DO NOT override state - let enrichmentStateService.stop() handle it
                }
            }
        });

        logger.debug("[Enrichment] Subscribed to control channel");
    }
}

/**
 * Start the unified enrichment worker (incremental mode)
 */
export async function startUnifiedEnrichmentWorker() {
    logger.debug("\n=== Starting Unified Enrichment Worker ===");
    logger.debug(`   Artist batch: ${ARTIST_BATCH_SIZE}`);
    logger.debug(`   Track batch: ${TRACK_BATCH_SIZE}`);
    logger.debug(`   Interval: ${ENRICHMENT_INTERVAL_MS / 1000}s`);
    logger.debug("");

    // Initialize state
    await enrichmentStateService.initializeState();

    // Setup control channel subscription
    await setupControlChannel();

    // Run immediately
    await runEnrichmentCycle(false);

    // Then run at interval
    enrichmentInterval = setInterval(async () => {
        await runEnrichmentCycle(false);
    }, ENRICHMENT_INTERVAL_MS);
}

/**
 * Stop the enrichment worker
 */
export function stopUnifiedEnrichmentWorker() {
    if (enrichmentInterval) {
        clearInterval(enrichmentInterval);
        enrichmentInterval = null;
        logger.debug("[Enrichment] Worker stopped");
    }
    if (redis) {
        redis.disconnect();
        redis = null;
    }
    if (controlSubscriber) {
        controlSubscriber.disconnect();
        controlSubscriber = null;
    }

    // Mark as stopped in state
    enrichmentStateService
        .updateState({
            status: "idle",
            currentPhase: null,
        })
        .catch((err) =>
            logger.error("[Enrichment] Failed to update state:", err),
        );
}

/**
 * Run a full enrichment (re-enrich everything regardless of status)
 * Called from Settings > Enrich All
 */
export async function runFullEnrichment(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("\n=== FULL ENRICHMENT: Re-enriching everything ===\n");

    // Reset pause state when starting full enrichment
    isPaused = false;

    // Initialize state for new enrichment
    await enrichmentStateService.initializeState();

    // Reset all statuses to pending
    await prisma.artist.updateMany({
        data: { enrichmentStatus: "pending" },
    });

    await prisma.track.updateMany({
        data: {
            lastfmTags: [],
            analysisStatus: "pending",
        },
    });

    // Now run the enrichment cycle
    const result = await runEnrichmentCycle(true);

    return result;
}

/**
 * Reset only artist enrichment (keeps mood tags and audio analysis intact)
 * Used when user wants to re-fetch artist metadata without touching track data
 */
export async function resetArtistsOnly(): Promise<{ count: number }> {
    logger.debug("[Enrichment] Resetting ONLY artist enrichment status...");

    const result = await prisma.artist.updateMany({
        where: { enrichmentStatus: "completed" },
        data: {
            enrichmentStatus: "pending",
            lastEnriched: null,
        },
    });

    logger.debug(`[Enrichment] Reset ${result.count} artists to pending`);
    return { count: result.count };
}

/**
 * Reset only mood tags (keeps artist metadata and audio analysis intact)
 * Used when user wants to re-fetch Last.fm mood tags without touching other enrichment
 */
export async function resetMoodTagsOnly(): Promise<{ count: number }> {
    logger.debug("[Enrichment] Resetting ONLY mood tags...");

    const result = await prisma.track.updateMany({
        data: { lastfmTags: [] },
    });

    logger.debug(`[Enrichment] Reset mood tags for ${result.count} tracks`);
    return { count: result.count };
}

/**
 * Reset only audio analysis (keeps artist metadata and mood tags intact)
 * Used when user wants to re-analyze audio files without touching metadata enrichment
 */
export async function resetAudioAnalysisOnly(): Promise<{ count: number }> {
    logger.debug("[Enrichment] Resetting ONLY audio analysis...");

    // Clean up stale processing first
    await audioAnalysisCleanupService.cleanupStaleProcessing();

    const result = await prisma.track.updateMany({
        where: {
            OR: [
                { analysisStatus: "completed" },
                { analysisStatus: "failed" },
                { analysisStatus: "processing" },
            ],
        },
        data: {
            analysisStatus: "pending",
            analysisStartedAt: null,
            analysisRetryCount: 0,
        },
    });

    logger.debug(
        `[Enrichment] Reset audio analysis for ${result.count} tracks`,
    );
    return { count: result.count };
}

/**
 * Main enrichment cycle
 *
 * Flow:
 * 1. Artist metadata (Last.fm/MusicBrainz) - blocking, required for track enrichment
 * 2. Track tags (Last.fm mood tags) - blocking, quick API calls
 * 3. Audio analysis (Essentia) - NON-BLOCKING, queued to Redis for background processing
 *
 * Steps 1 & 2 must complete before enrichment is "done".
 * Step 3 runs entirely in background via the audio-analyzer Docker container.
 *
 * @param fullMode - If true, processes everything. If false, only pending items.
 */
async function runEnrichmentCycle(fullMode: boolean): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    // Check if paused
    if (isPaused) {
        return { artists: 0, tracks: 0, audioQueued: 0 };
    }

    // Check state service
    const state = await enrichmentStateService.getState();
    if (state?.status === "paused" || state?.status === "stopping") {
        isPaused = true;
        return { artists: 0, tracks: 0, audioQueued: 0 };
    }

    // Allow immediate enrichment requests to bypass the isRunning check
    // This prevents race conditions when new content is imported
    if (isRunning && !fullMode && !immediateEnrichmentRequested) {
        return { artists: 0, tracks: 0, audioQueued: 0 };
    }

    // Enforce minimum interval between cycles (unless full mode or immediate request)
    const now = Date.now();
    if (
        !fullMode &&
        !immediateEnrichmentRequested &&
        now - lastRunTime < MIN_INTERVAL_MS
    ) {
        return { artists: 0, tracks: 0, audioQueued: 0 };
    }

    // Clear the immediate request flag
    immediateEnrichmentRequested = false;
    lastRunTime = now;

    isRunning = true;
    let artistsProcessed = 0;
    let tracksProcessed = 0;
    let audioQueued = 0;

    try {
        // Reset system failure counter on successful cycle start
        consecutiveSystemFailures = 0;

        // Update state - starting artists phase
        await enrichmentStateService.updateState({
            status: "running",
            currentPhase: "artists",
        });

        // Step 1: Enrich artists (blocking - required for step 2)
        artistsProcessed = await enrichArtistsBatch();

        // Check if stopping after artist phase
        if (isStopping) {
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
            });
            isStopping = false;
            return { artists: artistsProcessed, tracks: 0, audioQueued: 0 };
        }

        // Check if paused before continuing
        if (isPaused) {
            return { artists: artistsProcessed, tracks: 0, audioQueued: 0 };
        }

        // Update state - starting tracks phase
        await enrichmentStateService.updateState({
            currentPhase: "tracks",
        });

        // Step 2: Enrich track tags from Last.fm (blocking - quick API calls)
        tracksProcessed = await enrichTrackTagsBatch();

        // Check if stopping after track phase
        if (isStopping) {
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
            });
            isStopping = false;
            return {
                artists: artistsProcessed,
                tracks: tracksProcessed,
                audioQueued: 0,
            };
        }

        // Check if paused before continuing
        if (isPaused) {
            return {
                artists: artistsProcessed,
                tracks: tracksProcessed,
                audioQueued: 0,
            };
        }

        // Update state - starting audio phase
        await enrichmentStateService.updateState({
            currentPhase: "audio",
        });

        // Get current completed count before cleanup to detect successful analyzer activity
        const audioCompletedBefore = await prisma.track.count({
            where: { analysisStatus: "completed" },
        });

        // Clean up stale audio analysis jobs first
        const cleanupResult =
            await audioAnalysisCleanupService.cleanupStaleProcessing();
        if (cleanupResult.reset > 0 || cleanupResult.permanentlyFailed > 0) {
            logger.debug(
                `[Enrichment] Audio analysis cleanup: ${cleanupResult.reset} reset, ${cleanupResult.permanentlyFailed} permanently failed, ${cleanupResult.recovered} recovered`,
            );
        }

        // Check if analyzer completed tracks since last cycle (evidence it's working)
        const audioCompletedAfter = await prisma.track.count({
            where: { analysisStatus: "completed" },
        });
        if (audioCompletedAfter > audioCompletedBefore) {
            audioAnalysisCleanupService.recordSuccess();
        }

        // Check circuit breaker before queuing new tracks
        if (audioAnalysisCleanupService.isCircuitOpen()) {
            logger.warn(
                "[Enrichment] Audio analysis circuit breaker OPEN - skipping queue",
            );
            audioQueued = 0;
        } else {
            // Step 3: Queue audio analysis (NON-BLOCKING)
            audioQueued = await queueAudioAnalysis();
        }

        // Check if stopping after audio phase
        if (isStopping) {
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
            });
            isStopping = false;
            return {
                artists: artistsProcessed,
                tracks: tracksProcessed,
                audioQueued,
            };
        }

        // Check if paused before continuing
        if (isPaused) {
            return {
                artists: artistsProcessed,
                tracks: tracksProcessed,
                audioQueued,
            };
        }

        // Phase 4: Vibe embeddings (if CLAP available)
        let vibeQueued = 0;
        const features = await featureDetection.getFeatures();
if (features.vibeEmbeddings) {
             await enrichmentStateService.updateState({
                 currentPhase: "vibe",
             });

logger.debug("[ENRICHMENT] Phase 4: Cleaning up stale vibe processing");
              const { reset } = await vibeAnalysisCleanupService.cleanupStaleProcessing();

              if (reset > 0) {
                  logger.debug(`[ENRICHMENT] Cleaned up ${reset} stale vibe processing entries`);
              }

             logger.debug("[ENRICHMENT] Phase 4: Queueing vibe embeddings");
             vibeQueued = await queueVibeEmbeddings();
            if (vibeQueued > 0) {
                logger.debug(
                    `[ENRICHMENT] Queued ${vibeQueued} tracks for vibe embedding`
                );
            }
        }

        // Check if stopping after vibe phase
        if (isStopping) {
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
            });
            isStopping = false;
            return {
                artists: artistsProcessed,
                tracks: tracksProcessed,
                audioQueued,
            };
        }

        // Log progress (only if work was done)
        if (artistsProcessed > 0 || tracksProcessed > 0 || audioQueued > 0 || vibeQueued > 0) {
            const progress = await getEnrichmentProgress();
            logger.debug(`\n[Enrichment Progress]`);
            logger.debug(
                `   Artists: ${progress.artists.completed}/${progress.artists.total} (${progress.artists.progress}%)`,
            );
            logger.debug(
                `   Track Tags: ${progress.trackTags.enriched}/${progress.trackTags.total} (${progress.trackTags.progress}%)`,
            );
            logger.debug(
                `   Audio Analysis: ${progress.audioAnalysis.completed}/${progress.audioAnalysis.total} (${progress.audioAnalysis.progress}%) [background]`,
            );
            if (features.vibeEmbeddings) {
                logger.debug(
                    `   Vibe Embeddings: ${progress.clapEmbeddings.completed}/${progress.clapEmbeddings.total} (${progress.clapEmbeddings.progress}%) [background]`,
                );
            }
            logger.debug("");

            // Update state with progress
            await enrichmentStateService.updateState({
                artists: {
                    total: progress.artists.total,
                    completed: progress.artists.completed,
                    failed: progress.artists.failed,
                },
                tracks: {
                    total: progress.trackTags.total,
                    completed: progress.trackTags.enriched,
                    failed: 0,
                },
                audio: {
                    total: progress.audioAnalysis.total,
                    completed: progress.audioAnalysis.completed,
                    failed: progress.audioAnalysis.failed,
                    processing: progress.audioAnalysis.processing,
                },
                completionNotificationSent: false, // Reset flag when new work is processed
            });
        }

        // Send failure notification if there were any failures in this batch
        const totalFailures =
            currentBatchFailures.artists.length +
            currentBatchFailures.tracks.length +
            currentBatchFailures.audio.length;

        if (totalFailures > 0) {
            try {
                const failureCounts =
                    await enrichmentFailureService.getFailureCounts();

                const { notificationService } =
                    await import("../services/notificationService");
                const users = await prisma.user.findMany({
                    select: { id: true },
                });
                for (const user of users) {
                    await notificationService.create({
                        userId: user.id,
                        type: "error",
                        title: "Enrichment Completed with Errors",
                        message: `${failureCounts.total} items failed enrichment. Click to view and retry.`,
                        metadata: {
                            actionUrl: "/settings#enrichment-failures",
                            actionLabel: "View Failures",
                            failureCounts,
                        },
                    });
                }

                logger.debug(
                    `[Enrichment] Failure notification sent: ${totalFailures} failures in batch`,
                );
            } catch (error) {
                logger.error(
                    "[Enrichment] Failed to send failure notification:",
                    error,
                );
            }

            // Reset batch failures
            currentBatchFailures = { artists: [], tracks: [], audio: [] };
        }

        // If everything is complete, mark as idle and send notification (only once)
        const progress = await getEnrichmentProgress();

        // Clear mixes cache when core enrichment completes (artist images now available)
        if (progress.coreComplete) {
            const state = await enrichmentStateService.getState();
            if (!state?.coreCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys = await redisInstance.keys("mixes:*");
                    if (mixKeys.length > 0) {
                        await redisInstance.del(...mixKeys);
                        logger.info(
                            `[Enrichment] Cleared ${mixKeys.length} mix cache entries after core enrichment complete`,
                        );
                    }
                    await enrichmentStateService.updateState({
                        coreCacheCleared: true,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to clear mix cache on core complete:",
                        error,
                    );
                }
            }
        }

        if (progress.isFullyComplete) {
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
            });

            // Clear mixes cache again when fully complete (audio analysis done)
            const stateBeforeNotify = await enrichmentStateService.getState();
            if (!stateBeforeNotify?.fullCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys = await redisInstance.keys("mixes:*");
                    if (mixKeys.length > 0) {
                        await redisInstance.del(...mixKeys);
                        logger.info(
                            `[Enrichment] Cleared ${mixKeys.length} mix cache entries after full enrichment complete`,
                        );
                    }
                    await enrichmentStateService.updateState({
                        fullCacheCleared: true,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to clear mix cache on full complete:",
                        error,
                    );
                }
            }

            // Send completion notification only if not already sent
            const state = await enrichmentStateService.getState();
            if (!state?.completionNotificationSent) {
                try {
                    const { notificationService } =
                        await import("../services/notificationService");
                    // Get all users to notify (in a multi-user system, notify everyone)
                    const users = await prisma.user.findMany({
                        select: { id: true },
                    });
                    for (const user of users) {
                        await notificationService.notifySystem(
                            user.id,
                            "Enrichment Complete",
                            `Enriched ${progress.artists.completed} artists, ${progress.trackTags.enriched} tracks, ${progress.audioAnalysis.completed} audio analyses`,
                        );
                    }

                    // Mark notification as sent
                    await enrichmentStateService.updateState({
                        completionNotificationSent: true,
                    });
                    logger.debug("[Enrichment] Completion notification sent");
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to send completion notification:",
                        error,
                    );
                }
            } else {
                logger.debug(
                    "[Enrichment] Completion notification already sent, skipping",
                );
            }
        }
    } catch (error) {
        logger.error("[Enrichment] Cycle error:", error);

        // Increment system failure counter
        consecutiveSystemFailures++;

        // Circuit breaker: Stop recording system failures after threshold
        // This prevents infinite error loops when state management fails
        if (consecutiveSystemFailures <= MAX_CONSECUTIVE_SYSTEM_FAILURES) {
            // Record system-level failure
            await enrichmentFailureService
                .recordFailure({
                    entityType: "artist", // Generic type for system errors
                    entityId: "system",
                    entityName: "Enrichment System",
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                    errorCode: "SYSTEM_ERROR",
                })
                .catch((err) =>
                    logger.error("[Enrichment] Failed to record failure:", err),
                );
        } else {
            logger.error(
                `[Enrichment] Circuit breaker triggered - ${consecutiveSystemFailures} consecutive system failures. ` +
                    `Suppressing further error recording to prevent infinite loop.`,
            );
        }
    } finally {
        isRunning = false;
    }

    return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued };
}

/**
 * Step 1: Enrich artist metadata
 */
async function enrichArtistsBatch(): Promise<number> {
    // Get concurrency setting from system settings
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency || 1;

    const artists = await prisma.artist.findMany({
        where: {
            OR: [
                { enrichmentStatus: "pending" },
                { enrichmentStatus: "failed" },
            ],
            albums: { some: {} },
        },
        orderBy: { name: "asc" },
        take: ARTIST_BATCH_SIZE,
    });

    if (artists.length === 0) return 0;

    logger.debug(
        `[Artists] Processing ${artists.length} artists (concurrency: ${concurrency})...`,
    );

    // Use p-limit to control concurrency
    const limit = pLimit(concurrency);

    const results = await Promise.allSettled(
        artists.map((artist) =>
            limit(async () => {
                // Check if paused before processing
                if (isPaused) {
                    throw new Error("Paused");
                }

                // Update state with current artist
                await enrichmentStateService.updateState({
                    artists: {
                        current: artist.name,
                    } as any,
                });

                try {
                    // Add timeout to prevent hanging on rate-limited requests
                    // 60s to accommodate multiple sequential API calls (MusicBrainz, Wikidata, Last.fm, Fanart.tv, Deezer, covers)
                    await withTimeout(
                        enrichSimilarArtist(artist),
                        60000, // 60 second max per artist
                        `Timeout enriching artist: ${artist.name}`,
                    );
                    logger.debug(`✓ ${artist.name}`);
                    return artist.name;
                } catch (error) {
                    logger.error(`✗ ${artist.name}:`, error);

                    // Collect failure for batch reporting
                    currentBatchFailures.artists.push({
                        name: artist.name,
                        error:
                            error instanceof Error ?
                                error.message
                            :   String(error),
                    });

                    // Record failure
                    await enrichmentFailureService.recordFailure({
                        entityType: "artist",
                        entityId: artist.id,
                        entityName: artist.name,
                        errorMessage:
                            error instanceof Error ?
                                error.message
                            :   String(error),
                        errorCode:
                            (
                                error instanceof Error &&
                                error.message.includes("Timeout")
                            ) ?
                                "TIMEOUT_ERROR"
                            :   "ENRICHMENT_ERROR",
                        metadata: {
                            mbid: artist.mbid,
                        },
                    });
                    throw error;
                }
            }),
        ),
    );

    // Count successful enrichments
    const processed = results.filter((r) => r.status === "fulfilled").length;

    if (processed > 0) {
        logger.debug(
            `[Artists] Successfully enriched ${processed}/${artists.length} artists`,
        );
    }

    return processed;
}

/**
 * Step 2: Enrich track mood tags from Last.fm
 * Note: No longer waits for artist enrichment - runs in parallel
 */
async function enrichTrackTagsBatch(): Promise<number> {
    // Get concurrency setting from system settings
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency || 1;

    // Note: Nested orderBy on relations doesn't work with isEmpty filtering in Prisma
    // Track tag enrichment doesn't depend on artist enrichment status, so we just order by recency
    // Match both empty array AND null (newly scanned tracks have null, not [])
    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                { lastfmTags: { equals: [] } },
                { lastfmTags: { isEmpty: true } },
                { lastfmTags: { equals: null } },
            ],
        },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
        take: TRACK_BATCH_SIZE,
        orderBy: [{ fileModified: "desc" }],
    });

    if (tracks.length === 0) return 0;

    logger.debug(
        `[Track Tags] Processing ${tracks.length} tracks (concurrency: ${concurrency})...`,
    );

    // Use p-limit to control concurrency
    const limit = pLimit(concurrency);

    const results = await Promise.allSettled(
        tracks.map((track) =>
            limit(async () => {
                // Check if paused before processing
                if (isPaused) {
                    throw new Error("Paused");
                }

                // Update state with current track
                await enrichmentStateService.updateState({
                    tracks: {
                        current: `${track.album.artist.name} - ${track.title}`,
                    } as any,
                });

                try {
                    const artistName = track.album.artist.name;

                    // Add timeout to prevent hanging on rate-limited requests
                    const trackInfo = await withTimeout(
                        lastFmService.getTrackInfo(artistName, track.title),
                        30000, // 30 second max per track
                        `Timeout enriching track: ${track.title}`,
                    );

                    if (trackInfo?.toptags?.tag) {
                        const allTags = trackInfo.toptags.tag.map(
                            (t: any) => t.name,
                        );
                        const moodTags = filterMoodTags(allTags);

                        await prisma.track.update({
                            where: { id: track.id },
                            data: {
                                lastfmTags:
                                    moodTags.length > 0 ?
                                        moodTags
                                    :   ["_no_mood_tags"],
                            },
                        });

                        if (moodTags.length > 0) {
                            logger.debug(
                                `   ✓ ${track.title}: [${moodTags
                                    .slice(0, 3)
                                    .join(", ")}...]`,
                            );
                        }
                    } else {
                        await prisma.track.update({
                            where: { id: track.id },
                            data: { lastfmTags: ["_not_found"] },
                        });
                    }

                    // Small delay between requests
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    return track.title;
                } catch (error: any) {
                    logger.error(
                        `✗ ${track.title}: ${error?.message || error}`,
                    );

                    // Collect failure for batch reporting
                    currentBatchFailures.tracks.push({
                        name: `${track.album.artist.name} - ${track.title}`,
                        error: error?.message || String(error),
                    });

                    // Record failure
                    await enrichmentFailureService.recordFailure({
                        entityType: "track",
                        entityId: track.id,
                        entityName: `${track.album.artist.name} - ${track.title}`,
                        errorMessage: error?.message || String(error),
                        errorCode:
                            error?.message?.includes("Timeout") ?
                                "TIMEOUT_ERROR"
                            :   "LASTFM_ERROR",
                        metadata: {
                            albumId: track.albumId,
                            filePath: track.filePath,
                        },
                    });
                    throw error;
                }
            }),
        ),
    );

    // Count successful enrichments
    const processed = results.filter((r) => r.status === "fulfilled").length;

    if (processed > 0) {
        logger.debug(
            `[Track Tags] Successfully enriched ${processed}/${tracks.length} tracks`,
        );
    }

    return processed;
}

/**
 * Step 3: Queue pending tracks for audio analysis (Essentia)
 */
async function queueAudioAnalysis(): Promise<number> {
    // Find tracks that need audio analysis
    // All tracks should have filePath, so no null check needed
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "pending",
        },
        select: {
            id: true,
            filePath: true,
            title: true,
            duration: true,
        },
        take: 50, // Queue more at once since Essentia processes async
        orderBy: { fileModified: "desc" },
    });

    if (tracks.length === 0) return 0;

    logger.debug(
        `[Audio Analysis] Queueing ${tracks.length} tracks for Essentia...`,
    );

    const redis = getRedis();
    let queued = 0;

    for (const track of tracks) {
        try {
            // Queue for the Python audio analyzer
            await redis.rpush(
                "audio:analysis:queue",
                JSON.stringify({
                    trackId: track.id,
                    filePath: track.filePath,
                    duration: track.duration, // Avoids file read in analyzer
                }),
            );

            // Mark as queued (processing) with timestamp for timeout detection
            await prisma.track.update({
                where: { id: track.id },
                data: {
                    analysisStatus: "processing",
                    analysisStartedAt: new Date(),
                },
            });

            queued++;
        } catch (error) {
            logger.error(`   Failed to queue ${track.title}:`, error);
        }
    }

    if (queued > 0) {
        logger.debug(` Queued ${queued} tracks for audio analysis`);
    }

    return queued;
}

/**
 * Step 4: Queue tracks for CLAP vibe embeddings
 * Only runs if CLAP analyzer is available
 */
async function queueVibeEmbeddings(): Promise<number> {
     const tracks = await prisma.$queryRaw<{ id: string; filePath: string; vibeAnalysisStatus: string | null }[]>`
         SELECT t.id, t."filePath", t."vibeAnalysisStatus"
         FROM "Track" t
         LEFT JOIN track_embeddings te ON t.id = te.track_id
         WHERE te.track_id IS NULL
           AND t."filePath" IS NOT NULL
           AND (t."vibeAnalysisStatus" IS NULL OR t."vibeAnalysisStatus" = 'pending')
         LIMIT 1000
     `;

    if (tracks.length === 0) {
        return 0;
    }

const redis = getRedis();
     let queued = 0;

     for (const track of tracks) {
         try {
             if (track.vibeAnalysisStatus === 'processing') {
                 continue;
             }
             
             await prisma.track.update({
                 where: { id: track.id },
                 data: {
                     vibeAnalysisStatus: 'processing',
                     vibeAnalysisStartedAt: new Date(),
                 },
             });
             
             await redis.rpush(
                 "audio:clap:queue",
                 JSON.stringify({
                     trackId: track.id,
                     filePath: track.filePath,
                 })
             );
             
             queued++;
         } catch (error) {
             logger.error(`   Failed to queue vibe embedding for ${track.id}:`, error);
         }
     }

     return queued;
}

/**
 * Get comprehensive enrichment progress
 *
 * Returns separate progress for:
 * - Artists & Track Tags: "Core" enrichment (must complete before app is fully usable)
 * - Audio Analysis: "Background" enrichment (runs in separate container, non-blocking)
 */
export async function getEnrichmentProgress() {
    // Artist progress
    const artistCounts = await prisma.artist.groupBy({
        by: ["enrichmentStatus"],
        _count: true,
    });

    const artistTotal = artistCounts.reduce((sum, s) => sum + s._count, 0);
    const artistCompleted =
        artistCounts.find((s) => s.enrichmentStatus === "completed")?._count ||
        0;
    const artistPending =
        artistCounts.find((s) => s.enrichmentStatus === "pending")?._count || 0;

    // Track tag progress
    const trackTotal = await prisma.track.count();
    const trackTagsEnriched = await prisma.track.count({
        where: {
            AND: [
                { NOT: { lastfmTags: { equals: [] } } },
                { NOT: { lastfmTags: { equals: null } } },
            ],
        },
    });

    // Audio analysis progress (background task)
    const audioCompleted = await prisma.track.count({
        where: { analysisStatus: "completed" },
    });
    const audioPending = await prisma.track.count({
        where: { analysisStatus: "pending" },
    });
    const audioProcessing = await prisma.track.count({
        where: { analysisStatus: "processing" },
    });
    const audioFailed = await prisma.track.count({
        where: { analysisStatus: "failed" },
    });

    // CLAP embedding progress (for vibe similarity)
    const clapEmbeddingCount = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM track_embeddings
    `;
    const clapCompleted = Number(clapEmbeddingCount[0]?.count || 0);

    // CLAP/Vibe failure count
    const clapFailed = await prisma.enrichmentFailure.count({
        where: { entityType: "vibe", resolved: false, skipped: false },
    });

    // Core enrichment is complete when artists and track tags are done
    // Audio analysis is separate - it runs in background and doesn't block
    const coreComplete =
        artistPending === 0 && trackTotal - trackTagsEnriched === 0;

    return {
        // Core enrichment (blocking)
        artists: {
            total: artistTotal,
            completed: artistCompleted,
            pending: artistPending,
            failed:
                artistCounts.find((s) => s.enrichmentStatus === "failed")
                    ?._count || 0,
            progress:
                artistTotal > 0 ?
                    Math.round((artistCompleted / artistTotal) * 100)
                :   0,
        },
        trackTags: {
            total: trackTotal,
            enriched: trackTagsEnriched,
            pending: trackTotal - trackTagsEnriched,
            progress:
                trackTotal > 0 ?
                    Math.round((trackTagsEnriched / trackTotal) * 100)
                :   0,
        },

        // Background enrichment (non-blocking, runs in audio-analyzer container)
        audioAnalysis: {
            total: trackTotal,
            completed: audioCompleted,
            pending: audioPending,
            processing: audioProcessing,
            failed: audioFailed,
            progress:
                trackTotal > 0 ?
                    Math.round((audioCompleted / trackTotal) * 100)
                :   0,
            isBackground: true, // Flag to indicate this runs separately
        },

        // CLAP embeddings (for vibe similarity search)
        clapEmbeddings: {
            total: trackTotal,
            completed: clapCompleted,
            pending: trackTotal - clapCompleted - clapFailed,
            failed: clapFailed,
            progress:
                trackTotal > 0 ?
                    Math.round((clapCompleted / trackTotal) * 100)
                :   0,
            isBackground: true,
        },

        // Overall status
        coreComplete, // True when artists + track tags are done
        isFullyComplete:
            coreComplete && audioPending === 0 && audioProcessing === 0,
    };
}

/**
 * Trigger enrichment for a specific artist (used after new album added)
 */
export async function enrichArtistNow(artistId: string) {
    const artist = await prisma.artist.findUnique({
        where: { id: artistId },
    });

    if (!artist) return;

    logger.debug(`[Enrichment] Enriching artist: ${artist.name}`);
    await enrichSimilarArtist(artist);
}

/**
 * Trigger enrichment for a specific album's tracks
 */
/**
 * Trigger an immediate enrichment cycle (non-blocking)
 * Used when new tracks are added and we want to collect mood tags right away
 * instead of waiting for the 30s background interval
 */
export async function triggerEnrichmentNow(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("[Enrichment] Triggering immediate enrichment cycle...");

    // Reset pause state when triggering enrichment
    isPaused = false;

    // Set flag to bypass isRunning check (prevents race conditions)
    immediateEnrichmentRequested = true;

    return runEnrichmentCycle(false);
}

export async function enrichAlbumTracksNow(albumId: string) {
    const tracks = await prisma.track.findMany({
        where: { albumId },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
    });

    logger.debug(
        `[Enrichment] Enriching ${tracks.length} tracks for album ${albumId}`,
    );

    for (const track of tracks) {
        try {
            const trackInfo = await lastFmService.getTrackInfo(
                track.album.artist.name,
                track.title,
            );

            if (trackInfo?.toptags?.tag) {
                const allTags = trackInfo.toptags.tag.map((t: any) => t.name);
                const moodTags = filterMoodTags(allTags);

                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        lastfmTags:
                            moodTags.length > 0 ? moodTags : ["_no_mood_tags"],
                        analysisStatus: "pending", // Queue for audio analysis
                    },
                });
            }

            await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
            logger.error(`Failed to enrich track ${track.title}:`, error);
        }
    }
}
