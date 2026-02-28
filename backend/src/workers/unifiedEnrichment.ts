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
import { lastFmService } from "../services/lastfm";
import Redis from "ioredis";
import { config } from "../config";
import type { Worker as BullWorker } from "bullmq";
import {
    artistQueue,
    trackQueue,
    vibeQueue,
    podcastQueue,
    closeEnrichmentQueues,
} from "./enrichmentQueues";
import { startArtistEnrichmentWorker } from "./artistEnrichmentWorker";
import { startTrackEnrichmentWorker } from "./trackEnrichmentWorker";
import { startPodcastEnrichmentWorker } from "./podcastEnrichmentWorker";
import {
    startAudioCompletionSubscriber,
    stopAudioCompletionSubscriber,
} from "./audioCompletionSubscriber";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { audioAnalysisCleanupService } from "../services/audioAnalysisCleanup";
import { featureDetection } from "../services/featureDetection";

// Configuration
const ARTIST_BATCH_SIZE = 10;
const TRACK_BATCH_SIZE = 20;
const ENRICHMENT_INTERVAL_MS = 5 * 1000; // 5 seconds - rate limiter handles API limits
const MAX_CONSECUTIVE_SYSTEM_FAILURES = 5; // Circuit breaker threshold

let isRunning = false;
let enrichmentInterval: NodeJS.Timeout | null = null;
let redis: Redis | null = null;
let controlSubscriber: Redis | null = null;
let isPaused = false;
let isStopping = false;
let immediateEnrichmentRequested = false;
let activeEnrichmentWorkers: BullWorker[] = [];
let consecutiveSystemFailures = 0; // Track consecutive system-level failures
let lastRunTime = 0;
let audioLastCycleCompletedCount: number | null = null;
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

// Session-level failure counter (accumulates across cycles, reset on enrichment start)
let sessionFailureCount = { artists: 0, tracks: 0, audio: 0 };

// Timestamp for once-per-hour orphaned failure record cleanup
let lastOrphanedFailuresCleanup: Date | null = null;

// Timestamp for once-per-day resolved failure record cleanup (>30 days old)
let lastResolvedCleanup: Date | null = null;

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
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
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
                if (t.includes(mood)) return true;
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
                    Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(() => {});
                } else if (message === "resume") {
                    isPaused = false;
                    logger.debug("[Enrichment] Resumed");
                    Promise.all(activeEnrichmentWorkers.map((w) => w.resume())).catch(() => {});
                } else if (message === "stop") {
                    isStopping = true;
                    isPaused = true;
                    logger.debug(
                        "[Enrichment] Stopping gracefully - completing current item...",
                    );
                    // DO NOT override state - let enrichmentStateService.stop() handle it
                    // DO NOT kill the CLAP analyzer — it has its own idle timeout (MODEL_IDLE_TIMEOUT=300s)
                    // and will unload the model when the vibe queue is empty. Killing it caused
                    // permanent death because supervisor's autorestart didn't revive clean exits.
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

     // Crash recovery: reset orphaned tracks stuck in "processing" from a previous crash
     const orphanedAudio = await prisma.track.updateMany({
         where: { analysisStatus: "processing" },
         data: { analysisStatus: "pending", analysisStartedAt: null },
     });
     const orphanedVibe = await prisma.track.updateMany({
         where: { vibeAnalysisStatus: "processing" },
         data: { vibeAnalysisStatus: "pending", vibeAnalysisStartedAt: null },
     });
     if (orphanedAudio.count > 0 || orphanedVibe.count > 0) {
         logger.info(
             `[Enrichment] Crash recovery: reset ${orphanedAudio.count} orphaned audio + ${orphanedVibe.count} orphaned vibe tracks to pending`
         );
     }

     // Reset circuit breaker so stale failure state from a previous run doesn't block queuing
     audioAnalysisCleanupService.resetCircuitBreaker();

     // Reset local flags from any previous session
     isPaused = false;
     isStopping = false;

     // Check if there's existing state that might be problematic
     const existingState = await enrichmentStateService.getState();

     // Only clear state if it exists and is in a non-idle state
     // This prevents clearing fresh state from a previous worker instance
     if (existingState && existingState.status !== "idle") {
         await enrichmentStateService.clear();
     }

     // Initialize state
     await enrichmentStateService.initializeState();

    // Start BullMQ Workers (artist, track, podcast)
    activeEnrichmentWorkers = await Promise.all([
        startArtistEnrichmentWorker(),
        startTrackEnrichmentWorker(),
        startPodcastEnrichmentWorker(),
    ]);

    // Start audio completion subscriber (Essentia → vibe queue bridge)
    startAudioCompletionSubscriber();

    // Setup control channel subscription
    await setupControlChannel();

    // Run immediately
    await runEnrichmentCycle(false);

    // Self-rescheduling: schedule next cycle after current one completes
    scheduleNextEnrichmentCycle();
}

/**
 * Schedule the next enrichment cycle after the current one completes.
 * Replaces setInterval to prevent pile-up when cycles exceed ENRICHMENT_INTERVAL_MS.
 */
function scheduleNextEnrichmentCycle() {
    enrichmentInterval = setTimeout(async () => {
        await runEnrichmentCycle(false);
        scheduleNextEnrichmentCycle();
    }, ENRICHMENT_INTERVAL_MS);
}

/**
 * Stop the enrichment worker
 */
export async function stopUnifiedEnrichmentWorker() {
    if (enrichmentInterval) {
        clearTimeout(enrichmentInterval);
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

    // Close BullMQ Workers, audio subscriber, and Queues
    await Promise.all(activeEnrichmentWorkers.map((w) => w.close())).catch(() => {});
    activeEnrichmentWorkers = [];
    await stopAudioCompletionSubscriber().catch(() => {});
    await closeEnrichmentQueues().catch(() => {});

    // Mark as stopped in state
    await enrichmentStateService
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
            analysisRetryCount: 0,
            analysisError: null,
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
        where: { enrichmentStatus: { in: ["completed", "unresolvable"] } },
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
    const emptyResult = { artists: 0, tracks: 0, audioQueued: 0 };

    // Sync local pause flag with state service
    if (!isPaused) {
        const state = await enrichmentStateService.getState();
        if (state?.status === "paused" || state?.status === "stopping") {
            isPaused = true;
        }
    }

    if (isPaused) {
        return emptyResult;
    }

    // Never allow concurrent runs
    if (isRunning) {
        return emptyResult;
    }

    // Enforce minimum interval (unless full mode or immediate request)
    const bypassIntervalCheck = fullMode || immediateEnrichmentRequested;
    const now = Date.now();
    if (!bypassIntervalCheck && now - lastRunTime < MIN_INTERVAL_MS) {
        return emptyResult;
    }

    immediateEnrichmentRequested = false;
    lastRunTime = now;

    // Detect hangs: warn if enrichment has been "running" > 15 min with no state update
    const isHung = await enrichmentStateService.detectHang();
    if (isHung) {
        logger.warn("[Enrichment] Hang detected — enrichment has been running > 15 min with no activity");
    }

    isRunning = true;

    let artistsProcessed = 0;
    let tracksProcessed = 0;
    let audioQueued = 0;

    try {
        consecutiveSystemFailures = 0;

        // Run phases sequentially, halting if stopped/paused
        const artistResult = await runPhase("artists", executeArtistsPhase);
        if (artistResult === null) {
            return { artists: 0, tracks: 0, audioQueued: 0 };
        }
        artistsProcessed = artistResult;

        const trackResult = await runPhase("tracks", executeMoodTagsPhase);
        if (trackResult === null) {
            return { artists: artistsProcessed, tracks: 0, audioQueued: 0 };
        }
        tracksProcessed = trackResult;

        const audioResult = await runPhase("audio", executeAudioPhase);
        if (audioResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        audioQueued = audioResult;

        // Podcast refresh phase -- only runs if subscriptions exist
        await runPhase("podcasts", executePodcastRefreshPhase);

        // Vibe embedding sweep — catches tracks missed by the event-driven subscriber
        await runPhase("vibe", executeVibePhase);

        // Orphaned failure cleanup -- runs at most once per hour, never during stop/pause
        const ONE_HOUR_MS = 60 * 60 * 1000;
        if (!isStopping && !isPaused && (!lastOrphanedFailuresCleanup || Date.now() - lastOrphanedFailuresCleanup.getTime() > ONE_HOUR_MS)) {
            await enrichmentFailureService.cleanupOrphanedFailures();
            lastOrphanedFailuresCleanup = new Date();
        }

        // Daily: clean up old resolved failures (>30 days)
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        if (!isStopping && !isPaused && (!lastResolvedCleanup || Date.now() - lastResolvedCleanup.getTime() > ONE_DAY_MS)) {
            lastResolvedCleanup = new Date();
            await enrichmentFailureService.cleanupOldResolved();
        }

        const features = await featureDetection.getFeatures();

         // Log progress (only if work was done)
         if (artistsProcessed > 0 || tracksProcessed > 0 || audioQueued > 0) {
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

            // Reset session failure counter when new work begins
            sessionFailureCount = { artists: 0, tracks: 0, audio: 0 };
        }

        // Accumulate cycle failures into session counter before resetting
        sessionFailureCount.artists += currentBatchFailures.artists.length;
        sessionFailureCount.tracks += currentBatchFailures.tracks.length;
        sessionFailureCount.audio += currentBatchFailures.audio.length;

        // Reset batch failures (failures are viewable in Settings > Enrichment)
        currentBatchFailures = { artists: [], tracks: [], audio: [] };

        // If everything is complete, mark as idle and send notification (only once)
        const progress = await getEnrichmentProgress();

        // Clear mixes cache when core enrichment completes (artist images now available)
        if (progress.coreComplete) {
            const state = await enrichmentStateService.getState();
            if (!state?.coreCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys: string[] = [];
                    let scanCursor = "0";
                    do {
                        const [nextCursor, batch] = await redisInstance.scan(scanCursor, "MATCH", "mixes:*", "COUNT", 100);
                        scanCursor = nextCursor;
                        mixKeys.push(...batch);
                    } while (scanCursor !== "0");
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
                    const mixKeys: string[] = [];
                    let scanCursor = "0";
                    do {
                        const [nextCursor, batch] = await redisInstance.scan(scanCursor, "MATCH", "mixes:*", "COUNT", 100);
                        scanCursor = nextCursor;
                        mixKeys.push(...batch);
                    } while (scanCursor !== "0");
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
                    const totalSessionFailures =
                        sessionFailureCount.artists +
                        sessionFailureCount.tracks +
                        sessionFailureCount.audio;

                    for (const user of users) {
                        if (totalSessionFailures > 0) {
                            const parts: string[] = [];
                            if (sessionFailureCount.artists > 0) parts.push(`${sessionFailureCount.artists} artist(s)`);
                            if (sessionFailureCount.tracks > 0) parts.push(`${sessionFailureCount.tracks} track(s)`);
                            if (sessionFailureCount.audio > 0) parts.push(`${sessionFailureCount.audio} audio analysis`);

                            await notificationService.create({
                                userId: user.id,
                                type: "error",
                                title: "Enrichment Completed with Errors",
                                message: `${totalSessionFailures} failures: ${parts.join(", ")}. Check Settings > Enrichment for details.`,
                            });
                        }

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
 * Enrich a single track's tags from Last.fm.
 * Used by the BullMQ track enrichment Worker (Phase 4).
 */
export async function enrichSingleTrack(trackId: string): Promise<void> {
    const track = await prisma.track.findUnique({
        where: { id: trackId },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
    });

    if (!track) {
        const err = new Error(`ENTITY_NOT_FOUND: Track ${trackId} deleted`);
        (err as any).entityNotFound = true;
        throw err;
    }

    const artistName = track.album.artist.name;
    const trackInfo = await withTimeout(
        lastFmService.getTrackInfo(artistName, track.title),
        30000,
        `Timeout enriching track: ${track.title}`,
    );

    if (trackInfo?.toptags?.tag) {
        const allTags = trackInfo.toptags.tag.map((t: any) => t.name);
        const moodTags = filterMoodTags(allTags);
        await prisma.track.update({
            where: { id: track.id },
            data: {
                lastfmTags: moodTags.length > 0 ? moodTags : ["_no_mood_tags"],
            },
        });
        if (moodTags.length > 0) {
            logger.debug(`   ✓ ${track.title}: [${moodTags.slice(0, 3).join(", ")}...]`);
        }
    } else {
        await prisma.track.update({
            where: { id: track.id },
            data: { lastfmTags: ["_not_found"] },
        });
    }
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
            analysisRetryCount: { lt: 3 }, // matches Python's MAX_RETRIES — skip tracks the analyzer will ignore
        },
        select: {
            id: true,
            filePath: true,
            title: true,
            duration: true,
        },
        take: 10, // Match analyzer batch size to avoid stale "processing" buildup
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
 * Check if enrichment should stop and handle state cleanup if stopping.
 * Returns true if cycle should halt (either stopping or paused).
 */
async function shouldHaltCycle(): Promise<boolean> {
    if (isStopping) {
        await enrichmentStateService.updateState({
            status: "idle",
            currentPhase: null,
        });
        isStopping = false;
        return true;
    }
    return isPaused;
}

/**
 * Run a phase and return result. Returns null if cycle should halt.
 */
async function runPhase(
    phaseName: "artists" | "tracks" | "audio" | "podcasts" | "vibe",
    executor: () => Promise<number>,
): Promise<number | null> {
    await enrichmentStateService.updateState({
        status: "running",
        currentPhase: phaseName,
    });

    const result = await executor();

    if (await shouldHaltCycle()) {
        return null;
    }

    return result;
}

async function executeArtistsPhase(): Promise<number> {
    // Reset temp-MBID artists that have been unresolvable for >24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.artist.updateMany({
        where: {
            mbid: { startsWith: "temp-" },
            enrichmentStatus: "unresolvable",
            lastEnriched: { lt: oneDayAgo },
        },
        data: { enrichmentStatus: "pending" },
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pendingArtists = await prisma.artist.findMany({
        where: {
            OR: [
                { enrichmentStatus: "pending" },
                { enrichmentStatus: "failed" },
                { enrichmentStatus: "unresolvable", lastEnriched: { lt: sevenDaysAgo } },
            ],
            albums: { some: {} },
        },
        select: { id: true, name: true },
        take: ARTIST_BATCH_SIZE,
    });

    if (pendingArtists.length === 0) return 0;

    let queued = 0;
    for (const artist of pendingArtists) {
        try {
            // Add FIRST — if Redis is down, status stays "pending" and retries naturally
            await artistQueue.add(
                "enrich",
                { artistId: artist.id, artistName: artist.name },
                { jobId: `artist-${artist.id}` }, // dedup — no-op if already queued
            );
            // Update AFTER successful add
            await prisma.artist.update({
                where: { id: artist.id },
                data: { enrichmentStatus: "enriching" },
            });
            queued++;
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue artist ${artist.id}: ${(err as Error).message}`);
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} artists`);
    }
    return queued;
}

async function executeMoodTagsPhase(): Promise<number> {
    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                { lastfmTags: { equals: [] } },
                { lastfmTags: { isEmpty: true } },
            ],
            // Exclude tracks already queued this cycle — prevents re-adding the
            // same tracks on every 5s tick before the worker can process them.
            // The worker always overwrites ["_queued"] with real data or a
            // terminal sentinel (["_no_mood_tags"], ["_not_found"]).
            NOT: { lastfmTags: { has: "_queued" } },
        },
        select: { id: true, title: true },
        take: TRACK_BATCH_SIZE,
        orderBy: [{ fileModified: "desc" }],
    });

    if (tracks.length === 0) return 0;

    const queuedIds: string[] = [];
    for (const track of tracks) {
        try {
            await trackQueue.add(
                "enrich",
                { trackId: track.id, trackTitle: track.title },
                { jobId: `track-${track.id}` }, // dedup — no-op if already queued
            );
            queuedIds.push(track.id);
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue track ${track.id}: ${(err as Error).message}`);
        }
    }

    if (queuedIds.length > 0) {
        // Mark as in-flight so the next orchestrator tick skips them
        await prisma.track.updateMany({
            where: { id: { in: queuedIds } },
            data: { lastfmTags: ["_queued"] },
        });
        logger.debug(`[Enrichment] Queued ${queuedIds.length} tracks`);
    }
    return queuedIds.length;
}

async function executeAudioPhase(): Promise<number> {
    // Compare completed count to previous cycle (~1 min ago) — a much wider
    // window than the milliseconds between two counts around cleanupStaleProcessing().
    const currentCompleted = await prisma.track.count({
        where: { analysisStatus: "completed" },
    });

    if (audioLastCycleCompletedCount !== null && currentCompleted > audioLastCycleCompletedCount) {
        audioAnalysisCleanupService.recordSuccess();
    }
    audioLastCycleCompletedCount = currentCompleted;

    const cleanupResult =
        await audioAnalysisCleanupService.cleanupStaleProcessing();
    if (cleanupResult.reset > 0 || cleanupResult.permanentlyFailed > 0) {
        logger.debug(
            `[Enrichment] Audio analysis cleanup: ${cleanupResult.reset} reset, ${cleanupResult.permanentlyFailed} permanently failed, ${cleanupResult.recovered} recovered`,
        );
    }

    // Drain purgatory: tracks stuck as pending but retryCount >= MAX_RETRIES will never complete
    const purgatoryDrained = await prisma.track.updateMany({
        where: {
            analysisStatus: "pending",
            analysisRetryCount: { gte: 3 },
        },
        data: {
            analysisStatus: "failed",
            analysisError: "Exceeded retry limit — track may be corrupted or unsupported",
        },
    });
    if (purgatoryDrained.count > 0) {
        logger.warn(`[Enrichment] Drained ${purgatoryDrained.count} purgatory tracks to failed`);
    }

    if (audioAnalysisCleanupService.isCircuitOpen()) {
        logger.warn(
            "[Enrichment] Audio analysis circuit breaker OPEN - skipping queue",
        );
        return 0;
    }

    return queueAudioAnalysis();
}

const VIBE_SWEEP_BATCH_SIZE = 100;

async function executeVibePhase(): Promise<number> {
    const features = await featureDetection.getFeatures();
    if (!features.vibeEmbeddings) {
        return 0;
    }

    // Find tracks with completed audio analysis but no embedding row.
    // This catches:
    //   - Tracks orphaned by migration wiping track_embeddings
    //   - Tracks whose pub/sub completion event was missed (crash, restart)
    //   - Tracks reset to null/pending by crash recovery
    //   - Tracks with vibeAnalysisStatus='completed' but no actual embedding (stale status)
    const tracks = await prisma.$queryRaw<{ id: string; filePath: string }[]>`
        SELECT t.id, t."filePath"
        FROM "Track" t
        LEFT JOIN track_embeddings te ON t.id = te.track_id
        WHERE te.track_id IS NULL
          AND t."analysisStatus" = 'completed'
          AND t."filePath" IS NOT NULL
          AND (t."vibeAnalysisStatus" IS NULL
               OR t."vibeAnalysisStatus" = 'pending'
               OR t."vibeAnalysisStatus" = 'completed')
          AND (t."vibeAnalysisStatus" IS DISTINCT FROM 'processing')
        LIMIT ${VIBE_SWEEP_BATCH_SIZE}
    `;

    if (tracks.length === 0) {
        return 0;
    }

    // Reset stale vibeAnalysisStatus for these tracks before queuing
    const trackIds = tracks.map((t) => t.id);
    await prisma.track.updateMany({
        where: { id: { in: trackIds } },
        data: {
            vibeAnalysisStatus: "pending",
            vibeAnalysisError: null,
        },
    });

    let queued = 0;
    for (const track of tracks) {
        try {
            await vibeQueue.add(
                "embed",
                { trackId: track.id, filePath: track.filePath },
                { jobId: `vibe-${track.id}` },
            );
            queued++;
        } catch (err) {
            // jobId dedup: if already queued, BullMQ throws — that's fine
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Vibe sweep: queued ${queued} tracks for embedding`);
    }

    return queued;
}

async function executePodcastRefreshPhase(): Promise<number> {
    const podcastCount = await prisma.podcast.count();
    if (podcastCount === 0) return 0;

    const ONE_HOUR = 60 * 60 * 1000;
    const staleThreshold = new Date(Date.now() - ONE_HOUR);
    const stalePodcasts = await prisma.podcast.findMany({
        where: { lastRefreshed: { lt: staleThreshold } },
        select: { id: true, title: true },
    });

    if (stalePodcasts.length === 0) return 0;

    let queued = 0;
    for (const podcast of stalePodcasts) {
        try {
            await podcastQueue.add(
                "refresh",
                { podcastId: podcast.id, podcastTitle: podcast.title },
                { jobId: `podcast-${podcast.id}` }, // dedup — no-op if already queued
            );
            queued++;
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue podcast ${podcast.id}: ${(err as Error).message}`);
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} podcast refreshes`);
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
        (artistCounts.find((s) => s.enrichmentStatus === "completed")?._count || 0) +
        (artistCounts.find((s) => s.enrichmentStatus === "unresolvable")?._count || 0);
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
    const [clapEmbeddingCount, clapProcessing, clapQueueCounts, clapFailedCount, clapUnembeddedCount] = await Promise.all([
        prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `,
        prisma.track.count({
            where: { vibeAnalysisStatus: "processing" },
        }),
        vibeQueue.getJobCounts("active", "waiting", "delayed"),
        prisma.track.count({
            where: { vibeAnalysisStatus: "failed" },
        }),
        // Tracks with completed audio but no embedding and not failed
        prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count
            FROM "Track" t
            LEFT JOIN track_embeddings te ON t.id = te.track_id
            WHERE te.track_id IS NULL
              AND t."analysisStatus" = 'completed'
              AND t."filePath" IS NOT NULL
              AND (t."vibeAnalysisStatus" IS DISTINCT FROM 'failed')
        `,
    ]);
    const clapQueueLength = (clapQueueCounts.active ?? 0) + (clapQueueCounts.waiting ?? 0) + (clapQueueCounts.delayed ?? 0);
    const clapCompleted = Number(clapEmbeddingCount[0]?.count || 0);
    const clapFailed = clapFailedCount;
    const clapUnembedded = Number(clapUnembeddedCount[0]?.count || 0);

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
            processing: clapProcessing,
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
            coreComplete &&
            audioPending === 0 &&
            audioProcessing === 0 &&
            clapProcessing === 0 &&
            clapQueueLength === 0 &&
            clapUnembedded === 0,
    };
}

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

    // Set flag to bypass the minimum interval check (does NOT bypass isRunning —
    // a concurrent cycle will still cause this call to return an empty result)
    immediateEnrichmentRequested = true;

    return runEnrichmentCycle(false);
}

 /**
  * Re-run artist enrichment only (from the beginning)
  * Resets artist statuses and starts sequential enrichment from Phase 1
  */
 export async function reRunArtistsOnly(): Promise<{ count: number }> {
     logger.debug("[Enrichment] Re-running artist enrichment only...");

     const result = await resetArtistsOnly();

     logger.debug("[Enrichment] Starting sequential enrichment from artists phase...");
     isPaused = false;
     immediateEnrichmentRequested = true;

     // Run full cycle but it will stop after artists phase if paused/stopped
     const cycleResult = await runEnrichmentCycle(false);

     return { count: result.count };
 }

 /**
  * Re-run mood tags only (from the beginning)
  * Resets mood tags and starts sequential enrichment from Phase 1
  */
 export async function reRunMoodTagsOnly(): Promise<{ count: number }> {
     logger.debug("[Enrichment] Re-running mood tags only...");

     const result = await resetMoodTagsOnly();

     logger.debug("[Enrichment] Starting sequential enrichment from mood tags phase...");
     isPaused = false;
     immediateEnrichmentRequested = true;

     const cycleResult = await runEnrichmentCycle(false);

     return { count: result.count };
 }

 /**
  * Re-run audio analysis only
  * Cleans up stale jobs and queues for audio analysis
  */
 export async function reRunAudioAnalysisOnly(): Promise<number> {
     logger.debug("[Enrichment] Re-running audio analysis only...");

     // Reset circuit breaker first so cleanupStaleProcessing doesn't increment a failure
     // count that we're about to discard anyway
     audioAnalysisCleanupService.resetCircuitBreaker();

     await audioAnalysisCleanupService.cleanupStaleProcessing();

     // Reset all non-pending tracks so they get re-queued
     const reset = await prisma.track.updateMany({
         where: {
             analysisStatus: { not: "pending" },
         },
         data: {
             analysisStatus: "pending",
             analysisStartedAt: null,
             analysisRetryCount: 0,
         },
     });

     logger.debug(`[Enrichment] Reset ${reset.count} tracks to pending for audio re-analysis`);


     const queued = await queueAudioAnalysis();

     logger.debug(`[Enrichment] Queued ${queued} tracks for audio analysis`);

     // Trigger a cycle immediately so the UI shows running and progress updates
     isPaused = false;
     immediateEnrichmentRequested = true;
     runEnrichmentCycle(false).catch((err) =>
         logger.error("[Enrichment] reRunAudioAnalysisOnly cycle error:", err)
     );

     return queued;
 }

 /**
  * Re-run vibe embeddings only
  * Cleans up stale jobs and queues for vibe embeddings
  */
 export async function reRunVibeEmbeddingsOnly(): Promise<number> {
     logger.debug("[Enrichment] Re-running vibe embeddings only...");

     const features = await featureDetection.getFeatures();
     if (!features.vibeEmbeddings) {
         logger.debug("[Enrichment] Vibe embeddings not available, skipping");
         return 0;
     }

     // Delete all existing embeddings so tracks get fully regenerated
     const deleted = await prisma.trackEmbedding.deleteMany({});
     logger.debug(`[Enrichment] Deleted ${deleted.count} existing embeddings for full regeneration`);

     // Reset all tracks so they can be re-embedded.
     await prisma.track.updateMany({
         where: {
             analysisStatus: "completed",
         },
         data: {
             vibeAnalysisStatus: null,
             vibeAnalysisRetryCount: 0,
             vibeAnalysisStartedAt: null,
             vibeAnalysisStatusUpdatedAt: null,
         },
     });

     const tracks = await prisma.$queryRaw<{ id: string; filePath: string }[]>`
         SELECT t.id, t."filePath"
         FROM "Track" t
         WHERE t."analysisStatus" = 'completed'
           AND t."filePath" IS NOT NULL
         LIMIT 5000
     `;

     let queued = 0;
     for (const track of tracks) {
         try {
             await vibeQueue.add(
                 "embed",
                 { trackId: track.id, filePath: track.filePath },
                 { jobId: `vibe-${track.id}` },
             );
             queued++;
         } catch (err) {
             logger.error(`[Enrichment] Failed to queue vibe job for ${track.id}: ${(err as Error).message}`);
         }
     }

     logger.debug(`[Enrichment] Queued ${queued} tracks for vibe embeddings`);
     return queued;
 }
