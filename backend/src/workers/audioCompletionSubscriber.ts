import Redis from "ioredis";
import { vibeQueue } from "./enrichmentQueues";
import { config } from "../config";
import { logger } from "../utils/logger";
import * as stageRecords from "../services/stages/stageRecords";

const CHANNEL = "audio:analysis:complete";

interface AudioCompletionEvent {
    trackId: string;
    /** The per-attempt job id the report answers. */
    jobId?: string;
    status: string;
    /** Present when status is "failed": the analyzer's report of the error. */
    error?: string;
}

let subscriber: Redis | null = null;

/**
 * Halt vibe queuing and pause the vibe queue. Called on stop/pause.
 * Tracks completing audio analysis after this point will NOT be queued for vibe.
 */
export function haltVibeQueuing(): void {
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
    vibeQueue.resume().catch((err: Error) => {
        logger.warn(`[AudioSub] Failed to resume vibe queue: ${err.message}`);
    });
    logger.debug("[AudioSub] Vibe queuing resumed");
}

export async function startAudioCompletionSubscriber(): Promise<void> {
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

        if (!event.trackId) return;
        if (event.status !== "failed" && event.status !== "complete") return;
        if (!stageRecords.reportNamesClaim(event.trackId, "analysis", event.jobId)) return;

        // The analyzer writes no state; this event is its report, and the
        // stage record (and the status columns it mirrors) is settled here.
        if (event.status === "failed") {
            await stageRecords.fail(
                event.trackId,
                "analysis",
                "analyzer",
                new Error(event.error ?? "analysis failed"),
                { reported: "audio:analysis:complete" },
                event.jobId,
            ).catch((err: Error) =>
                logger.warn(`[AudioSub] Failed to record analysis failure: ${err.message}`),
            );
            return;
        }

        await stageRecords.answer(
            event.trackId,
            "analysis",
            "analyzer",
            { syncedFrom: "audio:analysis:complete", answer: "completed" },
            event.jobId,
        ).catch((err: Error) =>
            logger.warn(`[AudioSub] Failed to record analysis success: ${err.message}`),
        );
    });

    subscriber.on("error", (err) => {
        logger.error(`[AudioSub] Redis error: ${err.message}`);
    });
}

export async function stopAudioCompletionSubscriber(): Promise<void> {
    if (subscriber) {
        await subscriber.unsubscribe(CHANNEL).catch(() => {});
        await subscriber.quit().catch(() => {});
        subscriber = null;
    }
}
