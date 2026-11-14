/**
 * The fingerprint job: answer one song's fingerprint question with local fpcalc and store the fingerprint,
 * whatever identification later finds, since dedupe uses it too.
 *
 * Interface:
 *  - `answerFingerprint(item)`: one claimed question, answered or failed on its stage record.
 *  - `startFingerprint(item)` / `waitForFingerprintWork()`: the same through the pool, which runs up to
 *    availableParallelism() fpcalc runs at once, each bounded by the stage budget, and returns at once.
 *  - `createFingerprintPool(...)`: a pool of another size or budget (tests).
 *
 * The scheduler claims the record and offers the item; nothing here claims, queues or picks work. A stored
 * fingerprint is reused, never recomputed. Failures go through `stageRecords.fail`, a blown budget as a timeout.
 */

import os from "os";
import { logger } from "../../utils/logger";
import { withTimeout } from "../../utils/timeout";
import { prisma } from "../../utils/db";
import * as stageRecords from "../../services/stages/stageRecords";
import { persistAcoustidFingerprint } from "../../services/acoustidIdentification";
import { fpcalcService } from "../../services/fpcalc";
import { resolveWithinMusicRoot } from "../../routes/library/trackPath";

/** One claimed fingerprint question: the song, its file, and the claim's job id. */
export interface FingerprintItem {
    trackId: string;
    filePath: string | null;
    jobId: string;
}

/** The time one fpcalc run gets before it is recorded as a timed-out failure. */
const FINGERPRINT_BUDGET_MS = 30_000;

/** Evidence on a recording no-match that could not ask AcoustID: the file had no fingerprint. */
export const ACOUSTID_NOT_ASKED = "not asked: the file's fingerprint question closed";

/**
 * A fingerprint just landed: a recording no-match that closed without asking AcoustID,
 * for want of one, can ask now.
 */
async function reopenRecordingThatNeverAskedAcoustid(trackId: string): Promise<void> {
    try {
        const reopened = await stageRecords.askAgain({
            stages: ["recording"],
            trackIds: [trackId],
            statuses: ["done"],
            evidenceEquals: { acoustid: ACOUSTID_NOT_ASKED },
            evidence: { reason: "fingerprint landed" },
        });
        if (reopened > 0) {
            logger.debug(`[Enrichment] Fingerprint landed for ${trackId}: its recording question asks AcoustID now`);
        }
    } catch (err) {
        // The fingerprint is answered either way; this only leaves the recording closed as it was.
        logger.warn(`[Enrichment] Could not reopen the recording question for ${trackId}: ${(err as Error).message}`);
    }
}

/**
 * Answer one fingerprint question with local fpcalc and store the fingerprint
 * whatever identification later finds, since dedupe uses it too. A stored
 * fingerprint is reused, never recomputed. Failures go through stageRecords.fail.
 */
export async function answerFingerprint(item: FingerprintItem): Promise<void> {
    try {
        const track = await prisma.track.findUnique({
            where: { id: item.trackId },
            select: { acoustidFingerprint: true },
        });
        if (!track) {
            throw new Error(`ENTITY_NOT_FOUND: Track ${item.trackId} deleted`);
        }

        if (track.acoustidFingerprint) {
            await stageRecords.answer(item.trackId, "fingerprint", "fpcalc", {
                reason: "fingerprint already stored",
                characters: track.acoustidFingerprint.length,
            }, item.jobId);
            await reopenRecordingThatNeverAskedAcoustid(item.trackId);
            return;
        }

        if (!item.filePath) {
            throw new Error(
                `Track ${item.trackId} has no file path to fingerprint`,
            );
        }
        const absolutePath = resolveWithinMusicRoot(item.filePath);
        if (!absolutePath) {
            throw new Error(
                `Track ${item.trackId} path escapes the music folder: ${item.filePath}`,
            );
        }

        // Throws FpcalcFailure on a real failure — the error carries fpcalc's
        // exit code and stderr, so classifyFailure below sees the true reason.
        const fingerprint = await fpcalcService.fingerprintFile(absolutePath);

        await persistAcoustidFingerprint(item.trackId, fingerprint.fingerprint);
        await stageRecords.answer(item.trackId, "fingerprint", "fpcalc", {
            characters: fingerprint.fingerprint.length,
            duration: fingerprint.duration,
        }, item.jobId);
        await reopenRecordingThatNeverAskedAcoustid(item.trackId);
    } catch (err) {
        logger.debug(
            `[Enrichment] Fingerprint failed for ${item.trackId}: ${(err as Error).message}`,
        );
        await stageRecords.fail(item.trackId, "fingerprint", "fpcalc", err, {
            paths: ["fpcalc"],
        }, item.jobId);
    }
}

export interface FingerprintPool {
    /** Hand one claimed question to the pool and return at once; it answers on its own schedule. */
    start(item: FingerprintItem): void;
    /** Resolves once every question handed to the pool has settled. */
    settled(): Promise<void>;
}

/**
 * A pool of `concurrency` fpcalc runs at once, each bounded by `budgetMs`, so one hung run stalls nothing. A
 * timeout is recorded like any other fingerprint failure.
 */
export function createFingerprintPool(options: { concurrency: number; budgetMs: number }): FingerprintPool {
    let active = 0;
    const waiting: Array<() => void> = [];
    const work = new Set<Promise<void>>();

    async function slot<T>(task: () => Promise<T>): Promise<T> {
        while (active >= options.concurrency) {
            await new Promise<void>((resolve) => waiting.push(resolve));
        }
        active++;
        try {
            return await task();
        } finally {
            active--;
            waiting.shift()?.();
        }
    }

    return {
        start(item) {
            const run: Promise<void> = slot(() =>
                withTimeout(
                    answerFingerprint(item),
                    options.budgetMs,
                    `Timeout fingerprinting ${item.filePath ?? item.trackId}`,
                ),
            )
                .catch((err: unknown) => {
                    // The per-call budget expired (or the pool itself broke):
                    // record it as the classified failure it is — never a silent
                    // drop, never an unhandled rejection.
                    logger.warn(
                        `[Enrichment] Fingerprint work for ${item.trackId} did not finish: ${(err as Error).message}`,
                    );
                    return stageRecords.fail(
                        item.trackId,
                        "fingerprint",
                        "fpcalc",
                        err,
                        { paths: ["fpcalc"], timedOut: true },
                        item.jobId,
                    );
                })
                .finally(() => {
                    work.delete(run);
                });
            work.add(run);
        },
        async settled() {
            while (work.size > 0) {
                await Promise.allSettled([...work]);
            }
        },
    };
}

/** The scheduler's pool: up to availableParallelism() fpcalc runs at once. */
const pool = createFingerprintPool({
    concurrency: Math.max(1, os.availableParallelism()),
    budgetMs: FINGERPRINT_BUDGET_MS,
});

/** Run one claimed fingerprint question in the pool and return at once, so no stage or cycle waits on the sweep. */
export function startFingerprint(item: FingerprintItem): void {
    pool.start(item);
}

/** Resolves once every fingerprint run handed to the pool has settled. The engine never waits on
 * it (the pool answers on its own schedule); tests do. */
export async function waitForFingerprintWork(): Promise<void> {
    await pool.settled();
}
