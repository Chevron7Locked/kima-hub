/**
 * The `analysis` job: Essentia decode and measure, done by the Python analyzer.
 *
 * The analyzer consumes a plain Redis list, not a BullMQ queue. The job id names the claim, and the analyzer's
 * report carries it back. The scheduler keeps the order, the claim and the one-at-a-time rule against sound vectors;
 * this module owns what an analysis question looks like on the list and how deep a window it is offered in.
 */

import type { StageOffer, StageWork } from "./stageOffer";

/** The analyzer's input list. */
export const ANALYSIS_QUEUE = "audio:analysis:queue";

/** The one Redis call the job makes; the scheduler's lazily opened client satisfies it. */
export interface AnalysisList {
    rpush(key: string, value: string): Promise<number>;
}

/**
 * Hand a claimed attempt to the analyzer. The claim already put the song's status column to `processing`; nothing is
 * written after the push, so a fast report cannot be undone.
 */
export async function pushToAnalyzer(list: AnalysisList, item: StageWork): Promise<void> {
    await list.rpush(
        ANALYSIS_QUEUE,
        JSON.stringify({
            trackId: item.trackId,
            filePath: item.filePath,
            duration: item.duration,
            jobId: item.jobId,
        }),
    );
}

/**
 * Offer the songs whose analysis is owed and queue them. The window is its own, as deep as the stage may hold in
 * flight, so analysis overlaps network-bound identification and every worker always has its next track queued.
 * Nothing here flushes the analysis list or rewrites columns, which would let a queued job and its record disagree.
 */
export async function runAudioAnalysis(offer: StageOffer, list: AnalysisList): Promise<number> {
    const work = await offer.nextWork(await offer.window());
    return offer.dispatch(work, (item) => pushToAnalyzer(list, item));
}
