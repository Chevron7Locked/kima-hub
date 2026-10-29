/**
 * One queue per outside service, at that service's rate, with backoff and retries on a rate-limit reply. Five
 * rate limits in a row open a breaker that holds the service's next requests for a while.
 */

import PQueue from "p-queue";
import { logger } from "../utils/logger";

/**
 * Queue priority for work a person is waiting on (a page view). Background
 * enrichment queues at 0; during a full-library pass this is what keeps an
 * artist page from sitting behind thousands of queued sweep calls on the
 * 1-req/s services.
 */
export const INTERACTIVE_PRIORITY = 10;

/**
 * One caller's place in a service's queue, kept across its retries. Raising it moves a request still waiting in
 * the queue up to the new place, and any retry after that queues there too.
 */
export interface QueueTicket {
    priority: number;
    /** The id of this ticket's attempt while it waits in the queue; null once it runs. */
    waitingId: string | null;
}

let ticketSeq = 0;

/** `work`'s result, or a rejection with the signal's reason as soon as it is aborted; `work` is left to settle. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        work.catch(() => undefined);
        return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            work.catch(() => undefined);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

interface RateLimitConfig {
    /** Requests per interval */
    intervalCap: number;
    /** Interval in milliseconds */
    interval: number;
    /** Maximum concurrent requests */
    concurrency: number;
    /** Maximum retries on 429 */
    maxRetries: number;
    /** Base delay for exponential backoff (ms) */
    baseDelay: number;
}

interface ServiceConfig {
    musicbrainz: RateLimitConfig;
    deezer: RateLimitConfig;
    coverart: RateLimitConfig;
    lrclib: RateLimitConfig;
    songlink: RateLimitConfig;
    wikidata: RateLimitConfig;
    fanart: RateLimitConfig;
    itunes: RateLimitConfig;
    acoustid: RateLimitConfig;
    listenbrainz: RateLimitConfig;
}

const SERVICE_CONFIGS: ServiceConfig = {
    musicbrainz: {
        intervalCap: 1, // 1 request per second (MusicBrainz is strict)
        interval: 1100, // Slightly over 1 second to be safe
        concurrency: 1,
        maxRetries: 3,
        baseDelay: 2000,
    },
    deezer: {
        intervalCap: 25, // Deezer is more lenient
        interval: 5000,
        concurrency: 5,
        maxRetries: 2,
        baseDelay: 500,
    },
    coverart: {
        intervalCap: 5, // Cover Art Archive - conservative rate
        interval: 1000,
        concurrency: 3,
        maxRetries: 2,
        baseDelay: 1000,
    },
    lrclib: {
        intervalCap: 1, // LRCLIB documents 20 requests/minute
        interval: 3000,
        concurrency: 1,
        maxRetries: 1,
        baseDelay: 1000,
    },
    songlink: {
        intervalCap: 5,
        interval: 1000,
        concurrency: 2,
        maxRetries: 2,
        baseDelay: 1000,
    },
    wikidata: {
        intervalCap: 5, // Wikidata/Wikimedia API - no hard published limit, stay polite
        interval: 1000,
        concurrency: 3,
        maxRetries: 2,
        baseDelay: 1000,
    },
    fanart: {
        intervalCap: 2, // fanart.tv - personal API keys are lightly rate limited
        interval: 1000,
        concurrency: 1,
        maxRetries: 2,
        baseDelay: 1000,
    },
    itunes: {
        intervalCap: 1, // iTunes Search API - Apple documents ~20 requests/minute; stay conservative
        interval: 3000,
        concurrency: 1,
        maxRetries: 2,
        baseDelay: 2000,
    },
    acoustid: {
        intervalCap: 3, // 3 requests per second - matches AcoustID's shared-client-key limit
        interval: 1000,
        concurrency: 1,
        maxRetries: 1,
        baseDelay: 2000,
    },
    listenbrainz: {
        intervalCap: 1, // ListenBrainz asks clients for at most 1 request/second
        interval: 1100, // Slightly over 1 second to be safe
        concurrency: 1,
        maxRetries: 2,
        baseDelay: 2000,
    },
};

type ServiceName = keyof ServiceConfig;

/** How long an opened breaker first holds a service; each reopening doubles it, up to the cap. */
const CIRCUIT_RESET_MS = 30_000;
const CIRCUIT_MAX_RESET_MS = 60_000;
/** Rate limits in a row that open the breaker. */
const FAILURES_TO_OPEN = 5;
/** The longest one backoff waits. */
const MAX_BACKOFF_MS = 60_000;

interface CircuitState {
    isOpen: boolean;
    openedAt: number;
    consecutiveFailures: number;
    resetAfterMs: number;
}

/** Closes the breaker, its next hold back to CIRCUIT_RESET_MS: once its wait is over, or when the service answers. */
function closeCircuit(circuit: CircuitState): void {
    circuit.isOpen = false;
    circuit.consecutiveFailures = 0;
    circuit.resetAfterMs = CIRCUIT_RESET_MS;
}

class GlobalRateLimiter {
    private queues: Map<ServiceName, PQueue> = new Map();
    private circuitBreakers: Map<ServiceName, CircuitState> = new Map();

    constructor() {
        for (const [service, config] of Object.entries(SERVICE_CONFIGS)) {
            this.queues.set(
                service as ServiceName,
                new PQueue({
                    concurrency: config.concurrency,
                    intervalCap: config.intervalCap,
                    interval: config.interval,
                    carryoverConcurrencyCount: true,
                })
            );

            this.circuitBreakers.set(service as ServiceName, {
                isOpen: false,
                openedAt: 0,
                consecutiveFailures: 0,
                resetAfterMs: CIRCUIT_RESET_MS,
            });
        }

        logger.debug("Global rate limiter initialized");
    }

    /** Raise a ticket's place: a request still waiting moves up now, and its retries queue at the new place. */
    raise(service: ServiceName, ticket: QueueTicket, priority: number): void {
        if (priority <= ticket.priority) return;
        ticket.priority = priority;
        const waiting = ticket.waitingId;
        if (!waiting) return;
        try {
            this.queues.get(service)?.setPriority(waiting, priority);
        } catch {
            // Taken off the queue between the check and the move: it is already running.
        }
    }

    /** Runs `requestFn` in the service's queue, retrying a rate-limit reply with backoff. */
    async execute<T>(
        service: ServiceName,
        requestFn: () => Promise<T>,
        options?: {
            priority?: number;
            skipRetry?: boolean;
            /** A ticket the caller can raise with `raise` while this waits; it overrides `priority`. */
            ticket?: QueueTicket;
            /** Gives up: the call rejects at once, any wait here ends, and a request still queued is never sent. */
            signal?: AbortSignal;
        }
    ): Promise<T> {
        const ticket: QueueTicket = options?.ticket ?? { priority: options?.priority ?? 0, waitingId: null };
        const queue = this.queues.get(service);
        const config = SERVICE_CONFIGS[service];

        if (!queue || !config) {
            throw new Error(`Unknown service: ${service}`);
        }

        const circuit = this.circuitBreakers.get(service)!;
        if (circuit.isOpen) {
            const elapsed = Date.now() - circuit.openedAt;
            if (elapsed < circuit.resetAfterMs) {
                const waitTime = circuit.resetAfterMs - elapsed;
                logger.debug(`Circuit breaker open for ${service} - waiting ${waitTime}ms`);
                await this.sleep(waitTime, options?.signal);
            }
            closeCircuit(circuit);
        }

        const maxRetries = options?.skipRetry ? 0 : config.maxRetries;

        for (let attempt = 0; ; attempt++) {
            try {
                const id = `${service}-${++ticketSeq}`;
                ticket.waitingId = id;
                const queued = queue.add(
                    async () => {
                        ticket.waitingId = null;
                        return await requestFn();
                    },
                    { priority: ticket.priority, id, signal: options?.signal }
                );
                // p-queue checks the signal only when the request reaches the front: a request given up while it
                // waits then rejects there without being sent (and without using the interval). The caller is
                // answered when it gives up, not when that turn comes.
                const result = options?.signal ? await untilAborted(queued, options.signal) : await queued;

                // The service answered: it is not rate limiting any more, so a breaker opened while this request
                // was retrying closes too, or the next caller would sleep out a wait nothing needs.
                closeCircuit(circuit);
                return result as T;
            } catch (error: any) {
                // MusicBrainz answers a rate limit with 503, not 429.
                const isRateLimit =
                    error.response?.status === 429 ||
                    (service === "musicbrainz" && error.response?.status === 503) ||
                    error.message?.includes("429") ||
                    error.message?.toLowerCase().includes("rate limit");

                if (isRateLimit) {
                    circuit.consecutiveFailures++;

                    const delay = this.calculateBackoff(
                        attempt,
                        config.baseDelay,
                        error
                    );
                    logger.warn(
                        `Rate limited by ${service} (attempt ${attempt + 1}/${
                            maxRetries + 1
                        }) - backing off ${delay}ms`
                    );

                    if (circuit.consecutiveFailures >= FAILURES_TO_OPEN) {
                        circuit.isOpen = true;
                        circuit.openedAt = Date.now();
                        circuit.resetAfterMs = Math.min(CIRCUIT_MAX_RESET_MS, circuit.resetAfterMs * 2);
                        logger.warn(
                            `Circuit breaker opened for ${service} - will reset in ${circuit.resetAfterMs}ms`
                        );
                    }

                    if (attempt < maxRetries) {
                        await this.sleep(delay, options?.signal);
                        continue;
                    }
                }

                throw error;
            }
        }
    }

    /** The wait before a retry: the reply's Retry-After when it gives one, else exponential backoff with jitter. */
    private calculateBackoff(
        attempt: number,
        baseDelay: number,
        error?: any
    ): number {
        // A Retry-After of 0 says nothing about when to come back and an immediate retry is what rate limiting
        // punishes, so it falls through to backoff. A wait past the cap is not slept through in one request;
        // the stage's own retry ladder asks again later.
        const retryAfter = error?.response?.headers?.["retry-after"];
        if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed) && parsed > 0) {
                return Math.min(parsed * 1000, MAX_BACKOFF_MS);
            }
        }

        const exponentialDelay = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;
        return Math.min(exponentialDelay + jitter, MAX_BACKOFF_MS);
    }

    /** Scales every service's concurrency by 1-5, never past its per-interval cap. */
    updateConcurrencyMultiplier(multiplier: number) {
        const clampedMultiplier = Math.max(1, Math.min(5, multiplier));
        logger.debug(`[Rate Limiter] Updating concurrency multiplier to ${clampedMultiplier}`);
        for (const [service, config] of Object.entries(SERVICE_CONFIGS)) {
            const queue = this.queues.get(service as ServiceName);
            if (queue) {
                const newConcurrency = Math.min(
                    config.concurrency * clampedMultiplier,
                    config.intervalCap
                );
                queue.concurrency = newConcurrency;
                logger.debug(`  → ${service}: ${config.concurrency} → ${newConcurrency}`);
            }
        }
    }

    private sleep(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason);
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(signal!.reason);
            };
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }
}

export const rateLimiter = new GlobalRateLimiter();

export type { ServiceName };
