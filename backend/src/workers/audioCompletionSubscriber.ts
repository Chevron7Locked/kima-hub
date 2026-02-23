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

export function startAudioCompletionSubscriber(): void {
    // Resume in case a previous crash left the queue paused in Redis
    vibeQueue.resume().catch(() => {});

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
