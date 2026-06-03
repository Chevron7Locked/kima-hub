import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

const REQUEST_CHANNEL = "audio:text:embed";
const RESPONSE_PREFIX = "audio:text:embed:response:";
const TIMEOUT_MS = 15000;

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

let subscriberPromise: Promise<void> | null = null;

async function ensureSubscriber(): Promise<void> {
    if (subscriberPromise) return subscriberPromise;

    subscriberPromise = (async () => {
        // The parent redisClient sets enableOfflineQueue:false + maxRetriesPerRequest:0,
        // and duplicate() inherits them -- so psubscribe threw "Stream isn't writeable"
        // when the new subscriber socket wasn't connected yet, and the cached rejected
        // promise then broke vibe text search permanently until restart (#197). Give
        // the subscriber its own offline queue + retries so the command buffers until
        // the connection is ready.
        const sub = redisClient.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
        sub.on("error", (err: Error) => {
            logger.warn(`[TEXT-EMBED] subscriber error: ${err.message}`);
        });
        sub.on("end", () => {
            // Drop the cached subscriber so the next request reconnects rather than
            // reusing a dead connection.
            subscriberPromise = null;
        });
        sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
            const requestId = channel.slice(RESPONSE_PREFIX.length);
            emitter.emit(requestId, message);
        });
        await sub.psubscribe(`${RESPONSE_PREFIX}*`);
        logger.info("[TEXT-EMBED] Shared subscriber connected");
    })().catch((err) => {
        // Never cache a rejected promise -- one transient failure must not
        // permanently break vibe text search (#197).
        subscriberPromise = null;
        throw err;
    });

    return subscriberPromise;
}

/**
 * Request a text embedding from the Python CLAP analyzer via Redis pub/sub.
 * Uses a shared subscriber connection instead of creating one per request.
 */
export async function getTextEmbedding(text: string): Promise<number[]> {
    await ensureSubscriber();

    const requestId = randomUUID();

    const embeddingPromise = new Promise<number[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
            emitter.removeAllListeners(requestId);
            reject(new Error("Text embedding request timed out"));
        }, TIMEOUT_MS);

        emitter.once(requestId, (message: string) => {
            clearTimeout(timeout);
            try {
                const data = JSON.parse(message);
                if (data.error) {
                    reject(new Error(data.error));
                } else {
                    resolve(data.embedding);
                }
            } catch {
                reject(new Error("Invalid response from analyzer"));
            }
        });
    });

    await redisClient.publish(
        REQUEST_CHANNEL,
        JSON.stringify({ requestId, text })
    );

    return embeddingPromise;
}
