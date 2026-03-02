import Redis from "ioredis";
import { vibeQueue } from "./enrichmentQueues";
import { prisma } from "../utils/db";
import { config } from "../config";
import { logger } from "../utils/logger";

const CHANNEL = "audio:analysis:complete";
// Resume vibe embeddings after this many ms of Essentia silence.
// Keeps both ML models from loading simultaneously on low-RAM hosts.
const ESSENTIA_QUIET_MS = 30_000;

interface AudioCompletionEvent {
    trackId: string;
    filePath: string;
    status: string;
}

let subscriber: Redis | null = null;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let vibePaused = false;
let enrichmentHalted = false;

function pauseVibe(): void {
    if (!vibePaused) {
        vibePaused = true;
        vibeQueue.pause().catch((err: Error) => {
            logger.warn(`[AudioSub] Failed to pause vibe queue: ${err.message}`);
        });
        logger.debug("[AudioSub] Vibe queue paused (Essentia active)");
    }
}

function scheduleVibeResume(): void {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
        quietTimer = null;
        vibePaused = false;
        vibeQueue.resume().catch((err: Error) => {
            logger.warn(`[AudioSub] Failed to resume vibe queue: ${err.message}`);
        });
        logger.info("[AudioSub] Essentia idle — vibe queue resumed");
    }, ESSENTIA_QUIET_MS);
}

/**
 * Halt vibe queuing and pause the vibe queue. Called on stop/pause.
 * Tracks completing audio analysis after this point will NOT be queued for vibe.
 */
export function haltVibeQueuing(): void {
    enrichmentHalted = true;
    // Cancel any pending vibe resume timer
    if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
    }
    // Pause the vibe BullMQ queue so CLAP stops picking up jobs
    vibeQueue.pause().catch((err: Error) => {
        logger.warn(`[AudioSub] Failed to pause vibe queue on halt: ${err.message}`);
    });
    logger.debug("[AudioSub] Vibe queuing halted (enrichment stopped/paused)");
}

/**
 * Resume vibe queuing and unpause the vibe queue. Called on resume/re-run.
 */
export function resumeVibeQueuing(): void {
    enrichmentHalted = false;
    vibeQueue.resume().catch((err: Error) => {
        logger.warn(`[AudioSub] Failed to resume vibe queue: ${err.message}`);
    });
    logger.debug("[AudioSub] Vibe queuing resumed");
}

export async function startAudioCompletionSubscriber(): Promise<void> {
    // Only resume the vibe queue if no audio analysis is in progress.
    // If audio is running, the pauseVibe/scheduleVibeResume mechanism
    // will handle resuming after Essentia goes quiet.
    const audioProcessing = await prisma.track.count({
        where: { analysisStatus: "processing" },
    }).catch(() => 0);

    if (audioProcessing === 0) {
        vibeQueue.resume().catch(() => {});
    } else {
        logger.debug(`[AudioSub] ${audioProcessing} tracks in audio processing, keeping vibe queue paused`);
    }

    subscriber = new Redis(config.redisUrl);

    subscriber.subscribe(CHANNEL, (err) => {
        if (err) {
            logger.error(`[AudioSub] Subscribe failed: ${err.message}`);
            return;
        }
        logger.info(`[AudioSub] Subscribed to ${CHANNEL}`);
    });

    subscriber.on("message", async (_channel, message) => {
        let event: AudioCompletionEvent;
        try {
            event = JSON.parse(message);
        } catch {
            logger.warn(`[AudioSub] Invalid message: ${message}`);
            return;
        }

        if (event.status !== "complete" || !event.trackId) return;

        // Skip vibe queuing when enrichment is stopped/paused
        if (enrichmentHalted) return;

        // Gate CLAP behind Essentia: pause vibe queue while Essentia is active,
        // resume after ESSENTIA_QUIET_MS of silence. Prevents both ML models
        // from loading simultaneously on low-RAM hosts.
        pauseVibe();
        scheduleVibeResume();

        // Defensive guard: verify track analysisStatus in DB before queuing vibe.
        // Protects against pub/sub messages from failed Essentia runs.
        const track = await prisma.track
            .findUnique({
                where: { id: event.trackId },
                select: { analysisStatus: true, vibeAnalysisStatus: true },
            })
            .catch(() => null);

        if (!track) {
            logger.warn(`[AudioSub] Track ${event.trackId} not found, skipping vibe queue`);
            return;
        }

        if (track.analysisStatus !== "completed") {
            logger.warn(
                `[AudioSub] Track ${event.trackId} analysisStatus=${track.analysisStatus}, skipping vibe`,
            );
            return;
        }

        if (track.vibeAnalysisStatus === "completed") {
            return; // Already has vibe embedding
        }

        try {
            await vibeQueue.add(
                "embed",
                { trackId: event.trackId, filePath: event.filePath },
                { jobId: `vibe-${event.trackId}` }, // dedup — no-op if already queued
            );
            logger.debug(`[AudioSub] Queued vibe job for track ${event.trackId}`);
        } catch (err) {
            logger.error(`[AudioSub] Failed to queue vibe job: ${(err as Error).message}`);
        }
    });

    subscriber.on("error", (err) => {
        logger.error(`[AudioSub] Redis error: ${err.message}`);
    });
}

export async function stopAudioCompletionSubscriber(): Promise<void> {
    enrichmentHalted = false;
    if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
    }
    if (subscriber) {
        await subscriber.unsubscribe(CHANNEL).catch(() => {});
        await subscriber.quit().catch(() => {});
        subscriber = null;
    }
    // Don't leave the vibe queue paused in Redis across restarts
    if (vibePaused) {
        vibePaused = false;
        await vibeQueue.resume().catch(() => {});
    }
}
