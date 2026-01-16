/**
 * Global Rate Limiter Service
 *
 * Provides centralized rate limiting with exponential backoff for all external API calls.
 * Implements circuit breaker pattern to pause requests when rate limited.
 */

import PQueue from "p-queue";
import { logger } from "../utils/logger";

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
    lastfm: RateLimitConfig;
    musicbrainz: RateLimitConfig;
    deezer: RateLimitConfig;
    lidarr: RateLimitConfig;
    coverart: RateLimitConfig;
}

// Service-specific rate limit configurations
const SERVICE_CONFIGS: ServiceConfig = {
    lastfm: {
        intervalCap: 3, // 3 requests per second (Last.fm allows 5, but we're conservative)
        interval: 1000,
        concurrency: 2,
        maxRetries: 3,
        baseDelay: 1000,
    },
    musicbrainz: {
        intervalCap: 1, // 1 request per second (MusicBrainz is strict)
        interval: 1200, // Slightly over 1 second to be safe
        concurrency: 1,
        maxRetries: 5,
        baseDelay: 3000,
    },
    deezer: {
        intervalCap: 25, // Deezer is more lenient
        interval: 5000,
        concurrency: 5,
        maxRetries: 2,
        baseDelay: 500,
    },
    lidarr: {
        intervalCap: 10, // Local service, can be faster
        interval: 1000,
        concurrency: 3,
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
};

type ServiceName = keyof ServiceConfig;

interface CircuitState {
    isOpen: boolean;
    openedAt: number;
    consecutiveFailures: number;
    resetAfterMs: number;
}

class GlobalRateLimiter {
    private queues: Map<ServiceName, PQueue> = new Map();
    private circuitBreakers: Map<ServiceName, CircuitState> = new Map();
    private globalPaused = false;
    private globalPauseUntil = 0;
    private concurrencyMultiplier = 1; // 1-5 multiplier for user-configurable speed

    constructor() {
        // Initialize queues for each service
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
                resetAfterMs: 30000, // 30 seconds default
            });
        }

        logger.debug("Global rate limiter initialized");
    }

    /**
     * Execute a request with rate limiting and automatic retry
     */
    async execute<T>(
        service: ServiceName,
        requestFn: () => Promise<T>,
        options?: {
            priority?: number;
            skipRetry?: boolean;
        }
    ): Promise<T> {
        const queue = this.queues.get(service);
        const config = SERVICE_CONFIGS[service];

        if (!queue || !config) {
            throw new Error(`Unknown service: ${service}`);
        }

        // Check global pause
        if (this.globalPaused && Date.now() < this.globalPauseUntil) {
            const waitTime = this.globalPauseUntil - Date.now();
            logger.debug(`Global rate limit pause - waiting ${waitTime}ms`);
            await this.sleep(waitTime);
        }

        // Check circuit breaker
        const circuit = this.circuitBreakers.get(service)!;
        if (circuit.isOpen) {
            const elapsed = Date.now() - circuit.openedAt;
            if (elapsed < circuit.resetAfterMs) {
                // Circuit is open, wait or throw
                const waitTime = circuit.resetAfterMs - elapsed;
                logger.debug(
                    `Circuit breaker open for ${service} - waiting ${waitTime}ms`
                );
                await this.sleep(waitTime);
            }
            // Reset circuit to initial state
            circuit.isOpen = false;
            circuit.consecutiveFailures = 0;
            circuit.resetAfterMs = 30000; // Reset to initial 30 seconds
        }

        // Execute with retry logic
        let lastError: Error | null = null;
        const maxRetries = options?.skipRetry ? 0 : config.maxRetries;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const result = await queue.add(
                    async () => {
                        return await requestFn();
                    },
                    { priority: options?.priority ?? 0 }
                );

                // Success - reset failure count
                circuit.consecutiveFailures = 0;
                return result as T;
            } catch (error: any) {
                lastError = error;

                // Check if it's a rate limit error
                const status = error.response?.status;
                const headers = error.response?.headers || {};
                const responseError = error.response?.data?.error || "";
                const isMbRateLimited =
                    status === 503 &&
                    (headers["x-mb-rate-limiter"] ||
                        headers["x-ratelimit-zone"] ||
                        responseError
                            .toString()
                            .toLowerCase()
                            .includes("rate limit"));

                const isRateLimit =
                    status === 429 ||
                    error.message?.includes("429") ||
                    error.message?.toLowerCase().includes("rate limit") ||
                    isMbRateLimited;

                if (isRateLimit) {
                    circuit.consecutiveFailures++;

                    // Calculate backoff delay
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

                    // If too many failures, open circuit
                    if (circuit.consecutiveFailures >= 5) {
                        circuit.isOpen = true;
                        circuit.openedAt = Date.now();
                        circuit.resetAfterMs = Math.min(
                            60000,
                            circuit.resetAfterMs * 2
                        );
                        logger.warn(
                            `Circuit breaker opened for ${service} - will reset in ${circuit.resetAfterMs}ms`
                        );
                    }

                    if (attempt < maxRetries) {
                        await this.sleep(delay);
                        continue;
                    }
                }

                // Non-rate-limit error or max retries reached
                throw error;
            }
        }

        throw lastError || new Error("Request failed after retries");
    }

    /**
     * Calculate exponential backoff delay
     */
    private calculateBackoff(
        attempt: number,
        baseDelay: number,
        error?: any
    ): number {
        // Check for Retry-After header
        const retryAfter = error?.response?.headers?.["retry-after"];
        if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) {
                return parsed * 1000; // Convert to ms
            }
        }

        // Exponential backoff with jitter
        const exponentialDelay = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;
        return Math.min(exponentialDelay + jitter, 60000); // Cap at 60 seconds
    }

    /**
     * Pause all requests globally (for severe rate limiting)
     */
    pauseAll(durationMs: number) {
        this.globalPaused = true;
        this.globalPauseUntil = Date.now() + durationMs;
        logger.warn(`Global rate limiter paused for ${durationMs}ms`);
    }

    /**
     * Resume all requests
     */
    resume() {
        this.globalPaused = false;
        this.globalPauseUntil = 0;
        logger.debug("Global rate limiter resumed");
    }

    /**
     * Get queue statistics
     */
    getStats(): Record<ServiceName, { pending: number; size: number }> {
        const stats: any = {};
        for (const [service, queue] of this.queues.entries()) {
            stats[service] = {
                pending: queue.pending,
                size: queue.size,
            };
        }
        return stats;
    }

    /**
     * Wait for all pending requests to complete
     */
    async drain(): Promise<void> {
        const promises = Array.from(this.queues.values()).map((queue) =>
            queue.onIdle()
        );
        await Promise.all(promises);
    }

    /**
     * Clear all pending requests
     */
    clear() {
        for (const queue of this.queues.values()) {
            queue.clear();
        }
    }

    /**
     * Update concurrency multiplier for parallel enrichment processing
     * This allows power users to increase enrichment speed while respecting API rate limits
     * @param multiplier 1-5, where 1 is conservative and 5 is maximum
     */
    updateConcurrencyMultiplier(multiplier: number) {
        const clampedMultiplier = Math.max(1, Math.min(5, multiplier));
        this.concurrencyMultiplier = clampedMultiplier;
        
        logger.debug(`[Rate Limiter] Updating concurrency multiplier to ${clampedMultiplier}`);
        
        // Update all service queues with new concurrency
        for (const [service, config] of Object.entries(SERVICE_CONFIGS)) {
            const queue = this.queues.get(service as ServiceName);
            if (queue) {
                // Scale concurrency by multiplier, but never exceed intervalCap (rate limit)
                const newConcurrency = Math.min(
                    config.concurrency * clampedMultiplier,
                    config.intervalCap
                );
                queue.concurrency = newConcurrency;
                logger.debug(`  → ${service}: ${config.concurrency} → ${newConcurrency}`);
            }
        }
    }

    /**
     * Get current concurrency multiplier
     */
    getConcurrencyMultiplier(): number {
        return this.concurrencyMultiplier;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Singleton instance
export const rateLimiter = new GlobalRateLimiter();

// Export types for use in other services
export type { ServiceName, RateLimitConfig };
