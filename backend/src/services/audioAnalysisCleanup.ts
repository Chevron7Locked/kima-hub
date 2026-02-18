import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { enrichmentFailureService } from "./enrichmentFailureService";

const STALE_THRESHOLD_MINUTES = 15;
const MAX_RETRIES = 3;
const CIRCUIT_BREAKER_THRESHOLD = 30;
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000;

type CircuitState = "closed" | "open" | "half-open";

class AudioAnalysisCleanupService {
    private state: CircuitState = "closed";
    private failureCount = 0;
    private lastFailureTime: Date | null = null;
    private circuitOpenedAt: Date | null = null;

    private shouldAttemptReset(): boolean {
        if (!this.circuitOpenedAt) return false;
        const timeSinceOpen = Date.now() - this.circuitOpenedAt.getTime();
        return timeSinceOpen >= CIRCUIT_BREAKER_WINDOW_MS;
    }

    private onSuccess(): void {
        if (this.state === "half-open") {
            logger.info(
                `[AudioAnalysisCleanup] Circuit breaker CLOSED - recovery successful after ${this.failureCount} failures`
            );
            this.state = "closed";
            this.failureCount = 0;
            this.lastFailureTime = null;
            this.circuitOpenedAt = null;
        } else if (this.state === "closed" && this.failureCount > 0) {
            logger.debug(
                "[AudioAnalysisCleanup] Resetting failure counter on success"
            );
            this.failureCount = 0;
            this.lastFailureTime = null;
            this.circuitOpenedAt = null;
        }
    }

    private onFailure(
        resetCount: number,
        permanentlyFailedCount: number
    ): void {
        // Count cleanup runs, not individual tracks -- a single batch of stale
        // tracks shouldn't immediately trip the breaker
        this.failureCount += 1;
        this.lastFailureTime = new Date();

        if (this.state === "half-open") {
            this.state = "open";
            // Don't reset circuitOpenedAt — keep original open time so the
            // next shouldAttemptReset() fires immediately and retries HALF-OPEN
            logger.warn(
                `[AudioAnalysisCleanup] Circuit breaker REOPENED - recovery attempt failed (${this.failureCount} total failures)`
            );
        } else if (this.failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
            this.state = "open";
            this.circuitOpenedAt = new Date(); // fixed point — not updated on subsequent failures
            logger.warn(
                `[AudioAnalysisCleanup] Circuit breaker OPEN - ${this.failureCount} failures in window. ` +
                    `Pausing audio analysis queuing until analyzer shows signs of life.`
            );
        }
    }

    isCircuitOpen(): boolean {
        if (this.state === "open" && this.shouldAttemptReset()) {
            this.state = "half-open";
            logger.info(
                `[AudioAnalysisCleanup] Circuit breaker HALF-OPEN - attempting recovery after ${
                    CIRCUIT_BREAKER_WINDOW_MS / 60000
                } minute cooldown`
            );
        }
        return this.state === "open";
    }

    recordSuccess(): void {
        this.onSuccess();
    }

    resetCircuitBreaker(): void {
        this.state = "closed";
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.circuitOpenedAt = null;
        logger.debug("[AudioAnalysisCleanup] Circuit breaker reset");
    }

    async cleanupStaleProcessing(): Promise<{
        reset: number;
        permanentlyFailed: number;
        recovered: number;
    }> {
        const cutoff = new Date(
            Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000
        );

        const staleTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "processing",
                OR: [
                    { analysisStartedAt: { lt: cutoff } },
                    {
                        analysisStartedAt: null,
                        updatedAt: { lt: cutoff },
                    },
                ],
            },
            include: {
                album: {
                    include: {
                        artist: { select: { name: true } },
                    },
                },
            },
        });

        if (staleTracks.length === 0) {
            return { reset: 0, permanentlyFailed: 0, recovered: 0 };
        }

        logger.debug(
            `[AudioAnalysisCleanup] Found ${staleTracks.length} stale tracks (processing > ${STALE_THRESHOLD_MINUTES} min)`
        );

        let resetCount = 0;
        let permanentlyFailedCount = 0;
        let recoveredCount = 0;

        for (const track of staleTracks) {
            const newRetryCount = (track.analysisRetryCount || 0) + 1;
            const trackName = `${track.album.artist.name} - ${track.title}`;

            const existingEmbedding = await prisma.$queryRaw<{ count: bigint }[]>`
                SELECT COUNT(*) as count FROM track_embeddings WHERE track_id = ${track.id}
            `;

            if (Number(existingEmbedding[0]?.count) > 0) {
                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        analysisStatus: "completed",
                        analysisError: null,
                        analysisStartedAt: null,
                    },
                });

                logger.info(
                    `[AudioAnalysisCleanup] Recovered stale track with existing embedding: ${trackName}`
                );

                recoveredCount++;
                continue;
            }

            if (newRetryCount >= MAX_RETRIES) {
                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        analysisStatus: "failed",
                        analysisError: `Exceeded ${MAX_RETRIES} retry attempts (stale processing)`,
                        analysisRetryCount: newRetryCount,
                        analysisStartedAt: null,
                    },
                });

                await enrichmentFailureService.recordFailure({
                    entityType: "audio",
                    entityId: track.id,
                    entityName: trackName,
                    errorMessage: `Analysis timed out ${MAX_RETRIES} times - track may be corrupted or unsupported`,
                    errorCode: "MAX_RETRIES_EXCEEDED",
                    metadata: {
                        filePath: track.filePath,
                        retryCount: newRetryCount,
                    },
                });

                logger.warn(
                    `[AudioAnalysisCleanup] Permanently failed: ${trackName}`
                );
                permanentlyFailedCount++;
            } else {
                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        analysisStatus: "pending",
                        analysisStartedAt: null,
                        analysisRetryCount: newRetryCount,
                        analysisError: `Reset after stale processing (attempt ${newRetryCount}/${MAX_RETRIES})`,
                    },
                });

                logger.debug(
                    `[AudioAnalysisCleanup] Reset for retry (${newRetryCount}/${MAX_RETRIES}): ${trackName}`
                );
                resetCount++;
            }
        }

        if (resetCount > 0) {
            // Only count stale active tracks as circuit breaker failures.
            // Permanently failing a track is expected cleanup behavior,
            // not a sign that the analyzer is broken.
            this.onFailure(resetCount, permanentlyFailedCount);
        }

        if (recoveredCount > 0) {
            this.onSuccess();
        }

        logger.debug(
            `[AudioAnalysisCleanup] Cleanup complete: ${resetCount} reset, ${permanentlyFailedCount} permanently failed, ${recoveredCount} recovered`
        );

        return { reset: resetCount, permanentlyFailed: permanentlyFailedCount, recovered: recoveredCount };
    }

    async getStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
        circuitOpen: boolean;
        circuitState: CircuitState;
        failureCount: number;
    }> {
        const [pending, processing, completed, failed] = await Promise.all([
            prisma.track.count({ where: { analysisStatus: "pending" } }),
            prisma.track.count({ where: { analysisStatus: "processing" } }),
            prisma.track.count({ where: { analysisStatus: "completed" } }),
            prisma.track.count({ where: { analysisStatus: "failed" } }),
        ]);

        return {
            pending,
            processing,
            completed,
            failed,
            circuitOpen: this.state === "open",
            circuitState: this.state,
            failureCount: this.failureCount,
        };
    }
}

export const audioAnalysisCleanupService = new AudioAnalysisCleanupService();
