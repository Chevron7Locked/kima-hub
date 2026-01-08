/**
 * Enrichment API Client
 *
 * Client-side methods for enrichment control and failure management
 */

import { api } from "./api";

export interface EnrichmentState {
    status: "idle" | "running" | "paused" | "stopping";
    startedAt?: string;
    pausedAt?: string;
    stoppedAt?: string;
    currentPhase: "artists" | "tracks" | "audio" | null;
    lastActivity: string;
    stoppingInfo?: {
        phase: string;
        currentItem: string;
        itemsRemaining: number;
    };
    artists: {
        total: number;
        completed: number;
        failed: number;
        current?: string;
    };
    tracks: {
        total: number;
        completed: number;
        failed: number;
        current?: string;
    };
    audio: {
        total: number;
        completed: number;
        failed: number;
        processing: number;
    };
}

export interface EnrichmentFailure {
    id: string;
    entityType: "artist" | "track" | "audio";
    entityId: string;
    entityName: string | null;
    errorMessage: string | null;
    errorCode: string | null;
    retryCount: number;
    maxRetries: number;
    firstFailedAt: string;
    lastFailedAt: string;
    skipped: boolean;
    skippedAt: string | null;
    resolved: boolean;
    resolvedAt: string | null;
    metadata: Record<string, unknown> | null;
}

export interface FailureCounts {
    artist: number;
    track: number;
    audio: number;
    total: number;
}

export interface ConcurrencyConfig {
    concurrency: number;
    estimatedSpeed: string;
    artistsPerMin: number;
    tracksPerMin: number;
}

export interface AnalysisWorkersConfig {
    workers: number;
    cpuCores: number;
    recommended: number;
    description: string;
}

export const enrichmentApi = {
    /**
     * Get detailed enrichment state
     */
    getStatus: async (): Promise<EnrichmentState | null> => {
        return api.get("/enrichment/status");
    },

    /**
     * Pause enrichment
     */
    pause: async (): Promise<{ message: string; state: EnrichmentState }> => {
        return api.post("/enrichment/pause", {});
    },

    /**
     * Resume enrichment
     */
    resume: async (): Promise<{ message: string; state: EnrichmentState }> => {
        return api.post("/enrichment/resume", {});
    },

    /**
     * Stop enrichment
     */
    stop: async (): Promise<{ message: string; state: EnrichmentState }> => {
        return api.post("/enrichment/stop", {});
    },

    /**
     * Get enrichment failures with filtering
     */
    getFailures: async (params?: {
        entityType?: "artist" | "track" | "audio";
        includeSkipped?: boolean;
        includeResolved?: boolean;
        limit?: number;
        offset?: number;
    }): Promise<{ failures: EnrichmentFailure[]; total: number }> => {
        const query = new URLSearchParams();
        if (params?.entityType) query.set("entityType", params.entityType);
        if (params?.includeSkipped) query.set("includeSkipped", "true");
        if (params?.includeResolved) query.set("includeResolved", "true");
        if (params?.limit) query.set("limit", params.limit.toString());
        if (params?.offset) query.set("offset", params.offset.toString());

        const queryString = query.toString();
        return api.get(
            `/enrichment/failures${queryString ? `?${queryString}` : ""}`
        );
    },

    /**
     * Get failure counts by type
     */
    getFailureCounts: async (): Promise<FailureCounts> => {
        return api.get("/enrichment/failures/counts");
    },

    /**
     * Retry specific failures
     */
    retryFailures: async (
        ids: string[]
    ): Promise<{ message: string; queued: number }> => {
        return api.post("/enrichment/retry", { ids });
    },

    /**
     * Skip failures permanently
     */
    skipFailures: async (
        ids: string[]
    ): Promise<{ message: string; count: number }> => {
        return api.post("/enrichment/skip", { ids });
    },

    /**
     * Delete a failure record
     */
    deleteFailure: async (
        id: string
    ): Promise<{ message: string; count: number }> => {
        return api.delete(`/enrichment/failures/${id}`);
    },

    /**
     * Get enrichment concurrency configuration
     */
    getConcurrency: async (): Promise<ConcurrencyConfig> => {
        return api.get("/enrichment/concurrency");
    },

    /**
     * Set enrichment concurrency (1-5)
     */
    setConcurrency: async (concurrency: number): Promise<ConcurrencyConfig> => {
        return api.request("/enrichment/concurrency", {
            method: "PUT",
            body: JSON.stringify({ concurrency }),
        });
    },

    /**
     * Get audio analyzer worker configuration
     */
    getAnalysisWorkers: async (): Promise<AnalysisWorkersConfig> => {
        return api.get("/analysis/workers");
    },

    /**
     * Set audio analyzer worker count (1-8)
     */
    setAnalysisWorkers: async (workers: number): Promise<AnalysisWorkersConfig> => {
        return api.request("/analysis/workers", {
            method: "PUT",
            body: JSON.stringify({ workers }),
        });
    },
};
