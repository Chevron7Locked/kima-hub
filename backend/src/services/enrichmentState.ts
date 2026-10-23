/**
 * Enrichment State Management Service
 *
 * Manages the state of enrichment processes using Redis for cross-process coordination.
 * Allows pause/resume/stop controls and tracks current progress.
 */

import { logger } from "../utils/logger";
import Redis from "ioredis";
import { config } from "../config";
import { closeClient } from "../utils/closeRedisClient";

const ENRICHMENT_STATE_KEY = "enrichment:state";
const ENRICHMENT_CONTROL_CHANNEL = "enrichment:control";
const AUDIO_ANALYSIS_CONTROL_CHANNEL = "audio:analysis:control";
// Synchronous gate key -- Python checks this before any work path.
// Eliminates pub/sub timing races between Node.js stop and Python work pickup.
const AUDIO_ANALYSIS_GATE_KEY = "audio:analysis:gate";

type EnrichmentStatus = "idle" | "running" | "paused" | "stopping" | "failed";
export type EnrichmentPhase =
    | "artists"
    | "tracks"
    | "fingerprint"
    | "audio"
    | "podcasts"
    | "vibe"
    | "mood"
    | "similarity"
    | null;

interface EnrichmentState {
    status: EnrichmentStatus;
    startedAt?: string;
    pausedAt?: string;
    stoppedAt?: string;
    /** Set when a run transitioned to failed. */
    lastError?: string;
    currentPhase: EnrichmentPhase;
    lastActivity: string;
    completionNotificationSent?: boolean; // Set once a finished run has refreshed the failure alert and vibe map
    coreCacheCleared?: boolean; // Prevent repeated cache clearing on core complete
    fullCacheCleared?: boolean; // Prevent repeated cache clearing on full complete

    // Progress tracking
    artists: {
        total: number;
        completed: number;
        failed: number;
    };
    tracks: {
        total: number;
        completed: number;
        failed: number;
    };
    audio: {
        total: number;
        completed: number;
        failed: number;
        processing: number; // Currently in worker pool
    };
}

/**
 * Signature of the state that is actual work: progress counters and status.
 * Excludes lastActivity, currentPhase (rotated every cycle) and bookkeeping flags.
 */
export function progressSignature(state: EnrichmentState): string {
    return JSON.stringify({
        status: state.status,
        artists: state.artists,
        tracks: state.tracks,
        audio: state.audio,
    });
}

/**
 * Whether a write counts as activity for the hang detector: only counter or
 * status changes, never phase churn, or a stuck loop would look alive.
 */
export function shouldRefreshLastActivity(
    previous: EnrichmentState,
    next: EnrichmentState
): boolean {
    return progressSignature(previous) !== progressSignature(next);
}

class EnrichmentStateService {
    private redis: Redis;
    private publisher: Redis;

    constructor() {
        this.redis = new Redis(config.redisUrl);
        this.publisher = new Redis(config.redisUrl);
        this.redis.on('error', (err) => {
            logger.error('[EnrichmentState] Redis error:', err);
        });
        this.publisher.on('error', (err) => {
            logger.error('[EnrichmentState] Redis publisher error:', err);
        });
    }

    /**
     * Get current enrichment state
     */
    async getState(): Promise<EnrichmentState | null> {
        const data = await this.redis.get(ENRICHMENT_STATE_KEY);
        if (!data) {
            return null;
        }
        return JSON.parse(data);
    }

    /**
     * Initialize enrichment state
     */
    async initializeState(): Promise<EnrichmentState> {
        const state: EnrichmentState = {
            status: "running",
            startedAt: new Date().toISOString(),
            currentPhase: "artists",
            lastActivity: new Date().toISOString(),
            completionNotificationSent: false, // Reset notification flag on new enrichment
            coreCacheCleared: false, // Reset cache flag on new enrichment
            fullCacheCleared: false, // Reset cache flag on new enrichment
            artists: { total: 0, completed: 0, failed: 0 },
            tracks: { total: 0, completed: 0, failed: 0 },
            audio: { total: 0, completed: 0, failed: 0, processing: 0 },
        };

        await this.setState(state);
        return state;
    }

    /**
     * Persist state, refreshing `lastActivity` only on real work (see
     * shouldRefreshLastActivity). initializeState() always stamps it.
     */
    async setState(state: EnrichmentState, opts?: { stampActivity?: boolean }): Promise<void> {
        if (opts?.stampActivity !== false) {
            state.lastActivity = new Date().toISOString();
        }
        await this.redis.set(ENRICHMENT_STATE_KEY, JSON.stringify(state));
    }

    /**
     * Update specific fields in state
     * Only auto-initializes if the caller is explicitly starting enrichment.
     */
    async updateState(
        updates: Partial<EnrichmentState>
    ): Promise<EnrichmentState> {
        let current = await this.getState();

        if (!current) {
            if (updates.status === "running") {
                logger.debug("[Enrichment State] State not found, initializing...");
                current = await this.initializeState();
            } else {
                logger.debug("[Enrichment State] State not found, skipping update (not a start request)");
                return this.createDefaultIdleState();
            }
        }

        const updated = { ...current, ...updates };
        // Heartbeat honesty: stamp lastActivity only if the write actually
        // moved counters or changed status/phase. A phase-only rewrite of
        // status="running" over an unchanged counter set is the exact
        // false-heartbeat signature this class exists to kill.
        await this.setState(updated, {
            stampActivity: shouldRefreshLastActivity(current, updated),
        });
        return updated;
    }

    private createDefaultIdleState(): EnrichmentState {
        return {
            status: "idle",
            currentPhase: null,
            lastActivity: new Date().toISOString(),
            artists: { total: 0, completed: 0, failed: 0 },
            tracks: { total: 0, completed: 0, failed: 0 },
            audio: { total: 0, completed: 0, failed: 0, processing: 0 },
        };
    }

    /**
     * Pause enrichment process
     */
    async pause(): Promise<EnrichmentState> {
        const state = await this.getState();
        if (!state) {
            throw new Error("No active enrichment to pause");
        }

        if (state.status !== "running") {
            throw new Error(`Cannot pause enrichment in ${state.status} state`);
        }

        const updated = await this.updateState({
            status: "paused",
            pausedAt: new Date().toISOString(),
        });

        // Set synchronous gate BEFORE pub/sub -- Python checks this key atomically
        await this.redis.set(AUDIO_ANALYSIS_GATE_KEY, "paused");
        // Notify workers via pub/sub
        await this.publisher.publish(ENRICHMENT_CONTROL_CHANNEL, "pause");
        await this.publisher.publish(AUDIO_ANALYSIS_CONTROL_CHANNEL, "pause");

        logger.debug("[Enrichment State] Paused");
        return updated;
    }

    /**
     * Resume enrichment process
     */
    async resume(): Promise<EnrichmentState> {
        const state = await this.getState();
        if (!state) {
            throw new Error("No enrichment state to resume");
        }

        // Idempotent: If already running, return success
        if (state.status === "running") {
            logger.debug("[Enrichment State] Already running");
            return state;
        }

        if (state.status !== "paused") {
            throw new Error(
                `Cannot resume enrichment in ${state.status} state`
            );
        }

        const updated = await this.updateState({
            status: "running",
            pausedAt: undefined,
        });

        // Clear synchronous gate BEFORE pub/sub -- Python sees "open" immediately
        await this.redis.del(AUDIO_ANALYSIS_GATE_KEY);
        // Notify workers via pub/sub
        await this.publisher.publish(ENRICHMENT_CONTROL_CHANNEL, "resume");
        await this.publisher.publish(AUDIO_ANALYSIS_CONTROL_CHANNEL, "resume");

        logger.debug("[Enrichment State] Resumed");
        return updated;
    }

    /**
     * Stop enrichment process
     */
    async stop(): Promise<EnrichmentState> {
        const state = await this.getState();
        if (!state) {
            throw new Error("No active enrichment to stop");
        }

        // Idempotent: If already idle, return success
        if (state.status === "idle") {
            logger.debug("[Enrichment State] Already stopped (idle)");
            return state;
        }

        const updated = await this.updateState({
            status: "stopping",
            stoppedAt: new Date().toISOString(),
        });

        // Set synchronous gate BEFORE pub/sub -- Python checks this key atomically
        await this.redis.set(AUDIO_ANALYSIS_GATE_KEY, "paused");
        // Notify workers via pub/sub
        await this.publisher.publish(ENRICHMENT_CONTROL_CHANNEL, "stop");
        // Pause (not stop) the Python audio analyzer -- "stop" would exit the process
        // and supervisor would restart it immediately, defeating the purpose.
        // "pause" keeps it alive but idle; resume() sends "resume" to wake it.
        await this.publisher.publish(AUDIO_ANALYSIS_CONTROL_CHANNEL, "pause");

        logger.debug("[Enrichment State] Stopping (worker will transition to idle when current item completes)...");

        return updated;
    }
    async clear(): Promise<void> {
        await this.redis.del(ENRICHMENT_STATE_KEY);
        logger.debug("[Enrichment State] Cleared");
    }

    /**
     * Check if enrichment is paused
     */
    async isPaused(): Promise<boolean> {
        const state = await this.getState();
        return state?.status === "paused";
    }

    /**
     * Check for hung processes (no activity for > 15 minutes)
     */
    async detectHang(): Promise<boolean> {
        const state = await this.getState();
        if (!state || state.status !== "running") {
            return false;
        }

        const lastActivity = new Date(state.lastActivity);
        const now = new Date();
        const minutesSinceActivity =
            (now.getTime() - lastActivity.getTime()) / (1000 * 60);

        return minutesSinceActivity > 15;
    }

    /**
     * Clear the synchronous gate so Python can process work again.
     */
    async clearGate(): Promise<void> {
        await this.redis.del(AUDIO_ANALYSIS_GATE_KEY);
    }

    /**
     * Close the analysis gate without touching state. Used at startup to honour a
     * persisted pause when the gate key is gone (Redis flushed or expired).
     */
    async holdGateClosed(): Promise<void> {
        await this.redis.set(AUDIO_ANALYSIS_GATE_KEY, "paused");
    }

    /**
     * Publish a message to a Redis channel using the shared publisher connection.
     * Use this instead of creating ephemeral Redis connections.
     */
    async publishToChannel(channel: string, message: string): Promise<void> {
        await this.publisher.publish(channel, message);
    }

    /**
     * Cleanup connections
     */
    async disconnect(): Promise<void> {
        await closeClient(this.redis).catch(() => {});
        await closeClient(this.publisher).catch(() => {});
    }
}

// Singleton instance
export const enrichmentStateService = new EnrichmentStateService();
