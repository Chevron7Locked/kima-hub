/**
 * Enrichment State Management Service
 *
 * Manages the state of enrichment processes using Redis for cross-process coordination.
 * Allows pause/resume/stop controls and tracks current progress.
 */

import { logger } from "../utils/logger";
import Redis from "ioredis";
import { config } from "../config";

const ENRICHMENT_STATE_KEY = "enrichment:state";
const ENRICHMENT_CONTROL_CHANNEL = "enrichment:control";
const AUDIO_CONTROL_CHANNEL = "audio:analysis:control";

export type EnrichmentStatus = "idle" | "running" | "paused" | "stopping";
export type EnrichmentPhase = "artists" | "tracks" | "audio" | null;

export interface EnrichmentState {
    status: EnrichmentStatus;
    startedAt?: string;
    pausedAt?: string;
    stoppedAt?: string;
    currentPhase: EnrichmentPhase;
    lastActivity: string;
    completionNotificationSent?: boolean; // Prevent repeated completion notifications
    stoppingInfo?: {
        phase: string;
        currentItem: string;
        itemsRemaining: number;
    };

    // Progress tracking
    artists: {
        total: number;
        completed: number;
        failed: number;
        current?: string; // Currently processing artist name
    };
    tracks: {
        total: number;
        completed: number;
        failed: number;
        current?: string; // Currently processing track
    };
    audio: {
        total: number;
        completed: number;
        failed: number;
        processing: number; // Currently in worker pool
    };
}

class EnrichmentStateService {
    private redis: Redis;
    private publisher: Redis;

    constructor() {
        this.redis = new Redis(config.redisUrl);
        this.publisher = new Redis(config.redisUrl);
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
            artists: { total: 0, completed: 0, failed: 0 },
            tracks: { total: 0, completed: 0, failed: 0 },
            audio: { total: 0, completed: 0, failed: 0, processing: 0 },
        };

        await this.setState(state);
        return state;
    }

    /**
     * Update enrichment state
     */
    async setState(state: EnrichmentState): Promise<void> {
        state.lastActivity = new Date().toISOString();
        await this.redis.set(ENRICHMENT_STATE_KEY, JSON.stringify(state));
    }

    /**
     * Update specific fields in state
     * Auto-initializes state if it doesn't exist
     */
    async updateState(
        updates: Partial<EnrichmentState>
    ): Promise<EnrichmentState> {
        let current = await this.getState();

        // Auto-initialize if state doesn't exist
        if (!current) {
            logger.debug("[Enrichment State] State not found, initializing...");
            current = await this.initializeState();
        }

        const updated = { ...current, ...updates };
        await this.setState(updated);
        return updated;
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

        // Notify workers via pub/sub
        await this.publisher.publish(ENRICHMENT_CONTROL_CHANNEL, "pause");
        await this.publisher.publish(AUDIO_CONTROL_CHANNEL, "pause");

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

        // Notify workers via pub/sub
        await this.publisher.publish(ENRICHMENT_CONTROL_CHANNEL, "resume");
        await this.publisher.publish(AUDIO_CONTROL_CHANNEL, "resume");

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

        // Notify workers via pub/sub
        await this.publisher.publish(ENRICHMENT_CONTROL_CHANNEL, "stop");
        await this.publisher.publish(AUDIO_CONTROL_CHANNEL, "stop");

        logger.debug("[Enrichment State] Stopping...");

        // Transition to idle after a delay (workers will clean up)
        setTimeout(async () => {
            await this.updateState({ status: "idle", currentPhase: null });
            logger.debug("[Enrichment State] Stopped and idle");
        }, 5000);

        return updated;
    }

    /**
     * Clear enrichment state (set to idle)
     */
    async clear(): Promise<void> {
        await this.redis.del(ENRICHMENT_STATE_KEY);
        logger.debug("[Enrichment State] Cleared");
    }

    /**
     * Check if enrichment is currently running
     */
    async isRunning(): Promise<boolean> {
        const state = await this.getState();
        return state?.status === "running";
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
     * Cleanup connections
     */
    async disconnect(): Promise<void> {
        await this.redis.quit();
        await this.publisher.quit();
    }
}

// Singleton instance
export const enrichmentStateService = new EnrichmentStateService();
