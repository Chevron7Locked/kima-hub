/**
 * What each Lidarr webhook event does, shared by the live webhook route and the
 * reconciliation replay so both end in the same state.
 */

import { simpleDownloadManager } from "./simpleDownloadManager";
import { rejectSingleTrackPost } from "./lidarrFailures";
import { requestScan } from "../workers/scanRequest";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { webhookEventStore } from "./webhookEventStore";
import { webhookEventsTotal, webhookProcessingDuration } from "../utils/metrics";

/**
 * Run the side effects for one webhook event and return the correlation
 * id (download job id) when one was matched. Event names are Lidarr's
 * WebhookEventType; Health and Test events are no-ops.
 */
export async function dispatchWebhookEvent(
    eventType: string,
    payload: any
): Promise<string | undefined> {
    switch (eventType) {
        case "Grab":
            return handleGrab(payload);

        case "Download":
            return handleDownload(payload);

        // Lidarr sends ImportFailure when an import stops short. Whether that is a
        // parked download or junk only the queue item's status says, so the
        // watcher's queue judge decides; counting it here would count it twice.
        case "ImportFailure":
            return undefined;

        case "DownloadFailure":
            return handleDownloadFailure(payload);

        case "AlbumDelete":
            return handleAlbumDelete(payload);

        case "Rename":
        case "Retag":
            await requestScan({ source: "lidarr-rename" });
            return undefined;

        case "Health":
        case "HealthRestored":
        case "Test":
            return undefined;

        default:
            logger.debug(`   Unhandled event: ${eventType}`);
            return undefined;
    }
}

/** The events being processed. The route answers before its event is, so it does not await them. */
const processing = new Set<Promise<void>>();

/**
 * Resolves when every event being processed has ended and recorded its outcome, or after `timeoutMs` when one is
 * given. For tests, and for shutdown, which must not be held by an event that never finishes: that event is left
 * unprocessed in the store, and the reconciliation job replays it on the next start.
 */
export async function whenWebhooksIdle(timeoutMs?: number): Promise<void> {
    const idle = (async () => {
        while (processing.size > 0) await Promise.allSettled([...processing]);
    })();
    if (timeoutMs === undefined) return idle;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([idle, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
}

/** Dispatch a stored event and record the outcome on it; never throws. */
export function processStoredEvent(id: string, eventType: string, payload: any): Promise<void> {
    const run = processEvent(id, eventType, payload);
    processing.add(run);
    const forget = () => void processing.delete(run);
    run.then(forget, forget);
    return run;
}

async function processEvent(
    id: string,
    eventType: string,
    payload: any
): Promise<void> {
    const startTime = Date.now();
    let status = "success";
    try {
        let correlationId: string | undefined;
        try {
            correlationId = await dispatchWebhookEvent(eventType, payload);
        } catch (error: any) {
            status = "failed";
            logger.error(`[WEBHOOK] ${eventType} event ${id} failed:`, error.message);
            try {
                await webhookEventStore.markFailed(id, error.message);
            } catch (markError: any) {
                logger.error(`[WEBHOOK] Could not record the failure of ${id}:`, markError.message);
            }
            return;
        }
        await markProcessed(id, eventType, correlationId);
    } finally {
        // The outcome is recorded; a metrics call that throws must not turn this into a rejection.
        try {
            webhookEventsTotal.inc({ event_type: eventType, status });
            webhookProcessingDuration.observe({ event_type: eventType }, (Date.now() - startTime) / 1000);
        } catch (metricsError: any) {
            logger.warn(`[WEBHOOK] Could not record metrics for ${id}:`, metricsError.message);
        }
    }
}

/**
 * Records that an event's handlers ran. They have run by now, so a mark that will not stick is not a failed event:
 * it is tried once more, and then left unmarked. The reconciliation job replays an unmarked event like any not yet
 * processed (the handlers are safe to run again), instead of an error and a retry count being recorded against it.
 */
async function markProcessed(id: string, eventType: string, correlationId: string | undefined): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await webhookEventStore.markProcessed(id, correlationId);
            return;
        } catch (error: any) {
            if (attempt === 2) {
                logger.error(
                    `[WEBHOOK] ${eventType} event ${id} ran but could not be marked processed; leaving it for reconciliation:`,
                    error.message
                );
                return;
            }
            logger.warn(`[WEBHOOK] Could not mark ${id} processed, trying once more:`, error.message);
        }
    }
}

/**
 * Lidarr grabbed a release: every job on any album the release covers takes
 * the download (a bundle covers several), and the queue cleaner starts.
 */
async function handleGrab(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albums: any[] = payload.albums ?? [];

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }
    if (albums.length === 0) {
        logger.debug(`   Grab payload lists no albums, skipping`);
        return undefined;
    }

    const bundle = albums.length > 1;
    let firstJobId: string | undefined;
    for (const album of albums) {
        const result = await simpleDownloadManager.onDownloadGrabbed(
            downloadId,
            album?.mbId || "",
            album?.title || "",
            payload.artist?.name || "",
            album?.id || 0,
            { bundle }
        );
        if (result.matched) firstJobId ??= result.jobId;
    }
    if (!firstJobId) {
        logger.debug(`   No job asked for any of the ${albums.length} album(s); Lidarr grabbed on its own`);
        return undefined;
    }
    await rejectSingleTrackPost(downloadId, payload.release?.releaseTitle);
    return firstJobId;
}

/**
 * Handle Download event (download complete + imported).
 * A matched job scans under that job's id; an unmatched one still gets a
 * full scan — the files exist whether or not we tracked the download.
 */
async function handleDownload(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albumTitle = payload.album?.title;
    const artistName = payload.artist?.name;
    const albumMbid = payload.album?.mbId;
    const lidarrAlbumId = payload.album?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Album MBID: ${albumMbid}`);
    logger.debug(`   Lidarr Album ID: ${lidarrAlbumId}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }

    const filesImported: number | undefined = Array.isArray(payload.trackFiles) ? payload.trackFiles.length : undefined;
    const result = await simpleDownloadManager.onDownloadComplete(downloadId, albumMbid, lidarrAlbumId, albumTitle, filesImported);

    if (result.jobId) {
        const downloadJob = await prisma.downloadJob.findUnique({
            where: { id: result.jobId },
            select: { userId: true, id: true },
        });

        logger.debug(
            `   Triggering library scan for: ${artistName} - ${albumTitle}`
        );
        await requestScan({
            userId: downloadJob?.userId || undefined,
            source: "lidarr-webhook",
            albumMbid: albumMbid,
            downloadId: result.jobId,
        });

        return result.jobId;
    }
    if (filesImported === 0) return undefined;
    logger.debug(`   No matching job, triggering full scan anyway...`);
    await requestScan({
        source: "lidarr-import-external",
    });
    return undefined;
}

/**
 * A download failed in Lidarr: the download client gave up on it, or it was
 * removed with a blocklist. Counted against its jobs; Lidarr searches again by itself.
 */
async function handleDownloadFailure(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }
    const result = await simpleDownloadManager.onImportFailed(
        downloadId,
        payload.message || "Download failed",
        payload.album?.mbId
    );
    return result.jobId;
}

/**
 * Lidarr removed an album: a download running for it can never import, and
 * Discover must not try to delete the album again.
 */
async function handleAlbumDelete(payload: any): Promise<string | undefined> {
    const lidarrAlbumId = payload.album?.id;
    if (!lidarrAlbumId) return undefined;

    logger.debug(`   Album removed: ${payload.artist?.name} - ${payload.album?.title}`);
    return simpleDownloadManager.onAlbumDeleted(lidarrAlbumId);
}
