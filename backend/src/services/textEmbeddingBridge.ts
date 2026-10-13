import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { redisClient } from "../utils/redis";
import { withTimeout } from "../utils/timeout";
import { logger } from "../utils/logger";
import { efFor, withEfSearch } from "../utils/knn";
import { formatEmbedding } from "../utils/embedding";
import { MATCHING_MODEL } from "./matching/state";

const REQUEST_CHANNEL = "audio:text:embed";
const RESPONSE_PREFIX = "audio:text:embed:response:";
const TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 5000;
const PUBLISH_TIMEOUT_MS = 5000;

type RedisConn = ReturnType<typeof redisClient.duplicate>;

const emitter = new EventEmitter();
// One short-lived listener per in-flight request, keyed by requestId and removed
// on response or timeout, so the live count tracks real concurrency. A busy
// instance can legitimately exceed Node's default cap; disable the warning rather
// than pick an arbitrary ceiling that would mask a genuine leak.
emitter.setMaxListeners(0);

// The shared redisClient fails fast; text-embed pub/sub must ride out a cold
// or reconnecting Redis, so both ends use soft duplicates. A subscribing
// connection cannot publish, so the publisher is separate.
function softDuplicate(): RedisConn {
    return redisClient.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
}

let subscriber: RedisConn | null = null;
let subscriberPromise: Promise<RedisConn> | null = null;
let publisher: RedisConn | null = null;

function getPublisher(): RedisConn {
    if (publisher && publisher.status === "end") publisher = null;
    if (publisher) return publisher;

    const pub = softDuplicate();
    pub.on("error", (err: Error) => {
        logger.warn(`[TEXT-EMBED] publisher error: ${err.message}`);
    });
    pub.on("end", () => {
        if (publisher === pub) publisher = null;
    });
    publisher = pub;
    return pub;
}

async function ensureSubscriber(): Promise<RedisConn> {
    // ioredis reconnects and resubscribes on its own; only an ended subscriber
    // (after a failed setup) must be replaced, or requests would wait out the
    // timeout for replies that never come.
    if (subscriber && subscriber.status === "end") {
        subscriber = null;
        subscriberPromise = null;
    }
    if (subscriberPromise) return subscriberPromise;

    subscriberPromise = (async () => {
        const sub = softDuplicate();
        sub.on("error", (err: Error) => {
            // Do NOT drop the cached connection here: ioredis auto-reconnects and
            // re-issues the psubscribe (autoResubscribe), so resetting on every
            // transient error would spawn duplicate subscribers. Terminal death is
            // handled by the "end" handler and the status check above.
            logger.warn(`[TEXT-EMBED] subscriber error: ${err.message}`);
        });
        sub.on("end", () => {
            if (subscriber === sub) subscriber = null;
            subscriberPromise = null;
        });
        sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
            const requestId = channel.slice(RESPONSE_PREFIX.length);
            emitter.emit(requestId, message);
        });
        try {
            // Offline queue buffers psubscribe until connected; bound it so a
            // genuinely unreachable Redis fails instead of hanging the caller (the
            // per-request timeout only starts after this resolves).
            await withTimeout(sub.psubscribe(`${RESPONSE_PREFIX}*`), CONNECT_TIMEOUT_MS, "subscribe timed out");
        } catch (err) {
            sub.disconnect(); // close the half-open socket instead of leaking it
            throw err;
        }
        subscriber = sub;
        logger.info("[TEXT-EMBED] Shared subscriber connected");
        return sub;
    })().catch((err) => {
        // Never cache a rejected promise: one transient failure must not
        // permanently break vibe text search.
        subscriber = null;
        subscriberPromise = null;
        throw err;
    });

    return subscriberPromise;
}

/**
 * Request a text embedding from the Python CLAP analyzer via Redis pub/sub.
 * Uses long-lived shared subscriber + publisher connections (separate, because a
 * subscriber-mode connection cannot publish) configured to ride out a cold or
 * reconnecting Redis.
 */
async function getTextEmbedding(text: string): Promise<number[]> {
    await ensureSubscriber();

    const requestId = randomUUID();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const embeddingPromise = new Promise<number[]>((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
            emitter.removeAllListeners(requestId);
            reject(new Error("Text embedding request timed out"));
        }, TIMEOUT_MS);

        emitter.once(requestId, (message: string) => {
            clearTimeout(timeoutHandle);
            try {
                const data = JSON.parse(message);
                // The analyzer signals failure with { success:false, embedding:null }
                // and does not set data.error, so guard on all of them -- otherwise a
                // null / non-array embedding flows into the pgvector cast and 500s.
                if (data.error || data.success === false || !Array.isArray(data.embedding)) {
                    reject(new Error(data.error || "Analyzer failed to produce embedding"));
                } else {
                    resolve(data.embedding);
                }
            } catch {
                reject(new Error("Invalid response from analyzer"));
            }
        });
    });

    try {
        await withTimeout(
            getPublisher().publish(REQUEST_CHANNEL, JSON.stringify({ requestId, text })),
            PUBLISH_TIMEOUT_MS,
            "publish timed out"
        );
    } catch (err) {
        // The request never reached the analyzer; tear down the pending listener
        // and its timer so it cannot leak or reject unobserved.
        clearTimeout(timeoutHandle);
        emitter.removeAllListeners(requestId);
        throw err;
    }

    return embeddingPromise;
}

export interface TextSearchRow {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    /** pgvector cosine distance between the track and the query text. */
    distance: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

/**
 * Text search over CLAP embeddings: the `limit` nearest tracks, best first,
 * shared by /api/vibe/search and the public copy. No similarity cut-off:
 * text-to-audio cosine is comparable only within one query, and no threshold
 * measured on the full library separated "nothing matches" from "many match".
 */
export async function searchTracksByText(
    query: string,
    limit: number,
): Promise<TextSearchRow[]> {
    return searchTracksByEmbedding(await getTextEmbedding(query), limit);
}

/** The ranking half of searchTracksByText, for an already-embedded query. */
export async function searchTracksByEmbedding(
    embedding: number[],
    limit: number,
): Promise<TextSearchRow[]> {
    const vector = formatEmbedding(embedding);
    // Widen hnsw.ef_search, or any limit past 40 comes back short.
    return withEfSearch(efFor(limit), (tx) =>
        tx.$queryRaw<TextSearchRow[]>`
            SELECT
                t.id,
                t.title,
                t.duration,
                t."trackNo",
                te.embedding <=> ${vector}::vector AS distance,
                a.id AS "albumId",
                a.title AS "albumTitle",
                a."coverUrl" AS "albumCoverUrl",
                ar.id AS "artistId",
                ar.name AS "artistName"
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE t."missingSince" IS NULL AND te.model_version = ${MATCHING_MODEL}
            ORDER BY te.embedding <=> ${vector}::vector
            LIMIT ${limit}
        `,
    );
}
