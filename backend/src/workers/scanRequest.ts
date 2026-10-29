/**
 * The only producer for the library-scan queue. A request is deduped by scope
 * (download, album or import id, or "full") while one is waiting or running; a
 * finished marker is replaced so a new request always runs. Every scope walks
 * the whole music path; the ids only tell the processor which jobs it serves.
 */

import type { Job } from "bullmq";
import { scanQueue } from "./queues";
import type { ScanJobData } from "./processors/scanProcessor";

export interface ScanRequest {
    userId?: string;
    /** What asked for this scan, e.g. "lidarr-webhook", "auto-sync". */
    source: string;
    /** Download/album/import ids to reconcile after the walk. */
    downloadId?: string;
    albumMbid?: string;
    artistMbid?: string;
    spotifyImportJobId?: string;
    discoveryBatchId?: string;
    /** BullMQ priority (lower runs sooner); default 2 (BullMQ default). */
    priority?: number;
    /** Prune the job once done; default follows the queue options. */
    removeOnComplete?: boolean;
}

export type ScanRequestResult =
    | { queued: true; jobId: string }
    /** Not enqueued as a new job, but `jobId` still resolves to the
     *  scan covering this scope (wait/delayed/active). */
    | { queued: false; jobId: string; reason: string };

const LIVE_STATES = new Set(["waiting", "delayed", "active", "paused", "prioritized", "created"]);

export function scanDedupeKey(req: ScanRequest): string {
    // BullMQ forbids ':' in custom job ids (it owns that character for
    // Redis key layout), so the namespace separator is '-'. Scope ids are
    // cuids/mbids, never containing '-', so scopes stay prefix-free.
    const scopeId =
        req.downloadId ??
        req.albumMbid ??
        req.artistMbid ??
        req.spotifyImportJobId ??
        req.discoveryBatchId;
    return scopeId ? `scan-${scopeId}` : "scan-full";
}

/**
 * Enqueue a library scan, deduplicated by scope. Returns queued:false with
 * a reason when an identical scan is already live; never throws on that
 * account, but queue-connection errors propagate.
 */
export async function requestScan(req: ScanRequest): Promise<ScanRequestResult> {
    const jobId = scanDedupeKey(req);

    const existing: Job | undefined = await scanQueue.getJob(jobId);
    if (existing) {
        const state = await existing.getState();
        if (LIVE_STATES.has(state)) {
            return {
                queued: false,
                jobId,
                reason: `identical scan already ${state}`,
            };
        }
        // Stale completed/failed marker for this scope — a fresh request
        // means fresh work, so clear the marker and re-run. Without this,
        // BullMQ would dedupe against the old marker and silently swallow
        // every later request for the same id.
        await existing.remove();
    }

    const data: ScanJobData = {
        userId: req.userId,
        source: req.source,
        albumMbid: req.albumMbid,
        artistMbid: req.artistMbid,
        spotifyImportJobId: req.spotifyImportJobId,
        discoveryBatchId: req.discoveryBatchId,
    };

    await scanQueue.add("scan", data, {
        jobId,
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        ...(req.removeOnComplete !== undefined
            ? { removeOnComplete: req.removeOnComplete }
            : {}),
    });
    return { queued: true, jobId };
}
