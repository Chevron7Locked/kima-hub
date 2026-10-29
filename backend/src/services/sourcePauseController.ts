/**
 * Per-source pause, one `SourceAttempt` row per source. While a source is
 * refusing us no work is dequeued for it; the pause lifts at `nextRetryAt`.
 * A pause is not a failure: it uses no attempt and marks nothing failed, and
 * other sources keep working.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { isRateLimited } from "./enrichmentErrorCodeClassifier";

type SourceName = string;

/** How long a source rests after a rate limit before it is tried again. */
const DEFAULT_PAUSE_WINDOW_MS = 30_000;

interface SourcePauseState {
    source: SourceName;
    /** When the pause lifts. */
    until: Date;
    /** e.g. "RATE_LIMITED". */
    code: string;
    message: string | null;
}

interface PauseOptions {
    until: Date;
    code?: string;
    message?: string;
    evidence?: Record<string, unknown>;
}

class SourcePauseController {
    private readonly pauseWindowMs: number;

    constructor(opts?: { pauseWindowMs?: number }) {
        this.pauseWindowMs = opts?.pauseWindowMs ?? DEFAULT_PAUSE_WINDOW_MS;
    }

    /**
     * Pause `source` until `opts.until`. Idempotent: re-pausing refreshes
     * the deadline and the reason, and — because `source` is unique — this
     * is still one row, not one row per waiting track.
     */
    async pause(source: SourceName, opts: PauseOptions): Promise<void> {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "SourceAttempt"
                (id, source, status, attempt, "lastErrorCode", "lastErrorMessage",
                 "failureClass", retryable, "nextRetryAt", evidence, "startedAt")
             VALUES ($1, $2, 'paused', 0, $3, $4, NULL, true, $5, $6::jsonb, now())
             ON CONFLICT (source) DO UPDATE
                SET status = 'paused',
                    "lastErrorCode" = EXCLUDED."lastErrorCode",
                    "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                    "nextRetryAt" = EXCLUDED."nextRetryAt",
                    evidence = EXCLUDED.evidence`,
            `source:${source}`,
            source,
            opts.code ?? "RATE_LIMITED",
            opts.message ?? null,
            opts.until,
            JSON.stringify(opts.evidence ?? { reason: opts.message ?? "paused" }),
        );
        logger.debug(
            `[SourcePause] '${source}' paused until ${opts.until.toISOString()}`,
        );
    }

    /**
     * True while `source` is paused. A pause whose deadline has lapsed is
     * already released — the deadline is the truth, so a restart or a long
     * idle stretch never observes a lingering pause.
     */
    async isPaused(source: SourceName, now: Date = new Date()): Promise<boolean> {
        const rows = await prisma.$queryRawUnsafe<Array<{ source: string }>>(
            `SELECT source FROM "SourceAttempt"
              WHERE source = $1 AND status = 'paused' AND "nextRetryAt" > $2`,
            source,
            now,
        );
        return rows.length > 0;
    }

    /** The live pause for `source`, or null when it is not paused. */
    async getPause(
        source: SourceName,
        now: Date = new Date(),
    ): Promise<SourcePauseState | null> {
        const rows = await prisma.$queryRawUnsafe<
            Array<{
                source: string;
                "lastErrorCode": string | null;
                "lastErrorMessage": string | null;
                "nextRetryAt": Date;
            }>
        >(
            `SELECT source, "lastErrorCode", "lastErrorMessage", "nextRetryAt"
               FROM "SourceAttempt"
              WHERE source = $1 AND status = 'paused' AND "nextRetryAt" > $2`,
            source,
            now,
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            source: row.source,
            until: row.nextRetryAt,
            code: row.lastErrorCode ?? "RATE_LIMITED",
            message: row.lastErrorMessage,
        };
    }

    /**
     * Handle a source refusal: if `err` carries a rate-limit signal, pause
     * ONLY that source for the window and report it handled — the failure
     * is NOT counted (no attempt consumed, no `failed` mark). Returns true
     * when the error was source-caused and parked, false otherwise.
     */
    async handleRateLimit(
        source: SourceName,
        err: unknown,
        evidence?: Record<string, unknown>,
    ): Promise<boolean> {
        if (!isRateLimited(err)) return false;
        const message = err instanceof Error ? err.message : String(err);
        await this.pause(source, {
            until: new Date(Date.now() + this.pauseWindowMs),
            code: "RATE_LIMITED",
            message,
            evidence: { reason: "rate-limited", error: message, ...evidence },
        });
        return true;
    }

    /** Lift `source`'s pause, but only one set with `code`. */
    async release(source: SourceName, code: string, now: Date = new Date()): Promise<void> {
        await prisma.$executeRawUnsafe(
            `UPDATE "SourceAttempt" SET "nextRetryAt" = $3
              WHERE source = $1 AND status = 'paused' AND "lastErrorCode" = $2 AND "nextRetryAt" > $3`,
            source,
            code,
            now,
        );
    }

    /** Sources currently paused (for logging / diagnostics). */
    async listPaused(now: Date = new Date()): Promise<SourceName[]> {
        const rows = await prisma.$queryRawUnsafe<Array<{ source: string }>>(
            `SELECT source FROM "SourceAttempt"
              WHERE status = 'paused' AND "nextRetryAt" > $1`,
            now,
        );
        return rows.map((r) => r.source);
    }

    /** Test seam: expose the window so a test can pin the release timing. */
    get windowMs(): number {
        return this.pauseWindowMs;
    }
}

/** The shared controller, consulted by the stage dequeuer and every service that calls a rate-limited source. */
export const sourcePauseController = new SourcePauseController();