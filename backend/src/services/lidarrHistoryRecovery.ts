/**
 * Recovers Lidarr events whose webhook never arrived. Each history record is
 * stored as the webhook payload Lidarr would have sent, under the same event id,
 * so an event is handled once whichever way it reached Kima.
 */

import { prisma } from "../utils/db";
import * as downloadJobs from "./downloads/jobs";
import { getHistorySince, getImportedFiles } from "./lidarr";
import { webhookEventStore } from "./webhookEventStore";
import { processStoredEvent } from "./webhookHandlers";
import type { LidarrHistoryRecord } from "../types/lidarr";

const LOOKBACK_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 10 * 60 * 1000;

// Lidarr's EntityHistoryEventType and the webhook event it sends for it.
const HISTORY_EVENTS = [
    { historyType: 1, eventType: "Grab" },
    { historyType: 8, eventType: "Download" },
    { historyType: 4, eventType: "DownloadFailure" },
    { historyType: 7, eventType: "ImportFailure" },
];

const albumOf = (record: LidarrHistoryRecord) =>
    record.album && { id: record.album.id, mbId: record.album.foreignAlbumId, title: record.album.title };

/** `sameDownload`: a grab's records for every album it covers, or an import's per-file records. */
function toWebhookPayload(eventType: string, record: LidarrHistoryRecord, sameDownload: LidarrHistoryRecord[]) {
    const base = {
        eventType,
        downloadId: record.downloadId,
        artist: record.artist && { name: record.artist.artistName },
    };
    if (eventType === "Grab") {
        const albums = new Map(sameDownload.map((grab) => [grab.albumId, albumOf(grab)]));
        return { ...base, albums: [...albums.values()].filter(Boolean), release: { releaseTitle: record.sourceTitle } };
    }
    if (eventType === "Download") {
        const trackFiles = sameDownload.filter((f) => f.albumId === record.albumId).map((f) => ({ path: f.data?.importedPath }));
        return { ...base, album: albumOf(record), trackFiles };
    }
    return { ...base, album: albumOf(record), ...(record.data?.message && { message: record.data.message }) };
}

/**
 * Reads Lidarr history from 10 minutes before the newest stored event (or the oldest active
 * download, if earlier; at most 7 days back) and handles each record not seen yet in the order
 * Lidarr wrote them, so a second grab follows the failure of the first. Returns how many were new.
 */
export async function recoverMissedEvents(lidarrUrl: string, apiKey: string): Promise<number> {
    const now = Date.now();
    const newest = await prisma.webhookEvent.findFirst({
        where: { source: "lidarr" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
    });
    const oldestActive = await prisma.downloadJob.findFirst({
        where: { status: { in: downloadJobs.ACTIVE_STATUSES } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
    });
    const floor = now - LOOKBACK_FLOOR_MS;
    const fromEvents = (newest?.createdAt.getTime() ?? floor) - OVERLAP_MS;
    const since = new Date(Math.max(floor, Math.min(fromEvents, oldestActive?.createdAt.getTime() ?? fromEvents)));

    const missed: { eventType: string; record: LidarrHistoryRecord }[] = [];
    for (const { historyType, eventType } of HISTORY_EVENTS) {
        const records = await getHistorySince(lidarrUrl, apiKey, since, historyType);
        for (const record of records) {
            if (record.downloadId) missed.push({ eventType, record });
        }
    }
    missed.sort((a, b) => a.record.id - b.record.id);

    // A bundle's grab is one webhook listing every album, and one history record
    // per album. A finished download is recorded against every album it was
    // grabbed for, files or not, where the webhook comes only for an album that
    // got files; Lidarr's per-file records say which did.
    const grabs = new Map<string, LidarrHistoryRecord[]>();
    for (const { eventType, record } of missed) {
        if (eventType === "Grab") grabs.set(record.downloadId!, [...(grabs.get(record.downloadId!) ?? []), record]);
    }
    const imported = new Map<string, LidarrHistoryRecord[]>();

    let recovered = 0;
    for (const { eventType, record } of missed) {
        const id = record.downloadId!;
        if (await webhookEventStore.isStored("lidarr", toWebhookPayload(eventType, record, []))) continue;
        if (eventType === "Download" && !imported.has(id)) imported.set(id, await getImportedFiles(lidarrUrl, apiKey, id));
        const payload = toWebhookPayload(eventType, record, (eventType === "Grab" ? grabs : imported).get(id) ?? []);
        const { event, created } = await webhookEventStore.storeEvent("lidarr", eventType, payload);
        if (!created) continue;
        recovered++;
        await processStoredEvent(event.id, eventType, payload);
    }
    return recovered;
}
