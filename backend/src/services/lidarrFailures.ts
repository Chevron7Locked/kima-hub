/**
 * The one place Kima removes a download from Lidarr's queue. Each download id is
 * removed at most once, and only downloads belonging to a Kima job are swept.
 */

import { sourcePauseController } from "./sourcePauseController";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { lidarrService, type ReconciliationSnapshot } from "./lidarr";
import { getSystemSettings } from "../utils/systemSettings";
import { simpleDownloadManager } from "./simpleDownloadManager";
import type { LidarrQueueItem } from "../types/lidarr";

// What Lidarr says about a download that is not the album: nothing usable in
// it, the wrong album, or an archive that cannot be opened.
const JUNK_PATTERNS = [
    "No files found are eligible for import",
    "Found executable file",
    "unsupported extension",
    "Album match is not close enough",
    "No tracks matched",
    "Worst track match",
    "Unable to extract",
    "Failed to extract",
    "Unpacking failed",
    "unpack error",
    "Error extracting",
    "extraction failed",
    "corrupt archive",
    "invalid archive",
    "CRC failed",
    "bad archive",
].map((p) => p.toLowerCase());

const ALREADY_OWNED_PATTERNS = ["not an upgrade for existing", "not a custom format upgrade"];
const MISSING_TRACKS = "has missing tracks";
const EXTRA_TRACKS = "has unmatched tracks";
// Lidarr retries this one every cycle, and an extractor such as unpackerr clears it.
const AWAITING_EXTRACTION = "found archive file";
const GRACE_MS = 15 * 60 * 1000;
const NUMBERED_POST = /\[\s*(\d{1,3})\s*(?:\/|of|\+)\s*(\d{1,3})\s*\]/i;
// "[24/96]" is a hi-res album's bit depth and sample rate, not track 24 of 96.
const HI_RES = /^(?:16|24|32)$/;
const SAMPLE_RATE = /^(?:44|48|88|96|176|192|352|384)$/;

/** A Usenet post of one track ("[03/11]"), not the album. */
function isSingleTrackPost(title: string): boolean {
    const m = NUMBERED_POST.exec(title);
    if (!m) return false;
    const [, part, of] = m;
    return Number(part) <= Number(of) && !(HI_RES.test(part) && SAMPLE_RATE.test(of));
}

export type QueueVerdict = { action: "reject" | "owned" | "junk" | "parked"; reason: string };

/**
 * What a queue item needs: a single-track post is turned away (not an attempt); an album the
 * library already holds closes its job; junk is removed so Lidarr tries the next release; anything
 * else Lidarr stopped on, missing tracks above all, is parked for a person. Null while it is running.
 */
export function judgeQueueItem(item: LidarrQueueItem, now = Date.now()): QueueVerdict | null {
    if (isSingleTrackPost(item.title ?? "")) return { action: "reject", reason: "Single-track post" };

    // Lidarr puts some reasons in a status message's title ("No files found
    // are eligible for import") and others in its list of messages.
    const messages = (item.statusMessages ?? []).flatMap((sm) => [sm.title, ...sm.messages]);
    const has = (patterns: string[]) =>
        messages.find((m) => patterns.some((p) => m.toLowerCase().includes(p)));

    const added = item.added ? Date.parse(item.added) : NaN;
    if (has([AWAITING_EXTRACTION]) && now - added < GRACE_MS) return null;

    const junk = has(JUNK_PATTERNS);
    if (junk) return { action: "junk", reason: junk };
    // Missing tracks come before "not an upgrade": some tracks already owned
    // and the rest missing is still an album that is not whole.
    if (has([MISSING_TRACKS])) return { action: "parked", reason: "Tracks missing" };
    if (has([EXTRA_TRACKS])) return { action: "parked", reason: "Tracks Lidarr could not match" };
    const owned = has(ALREADY_OWNED_PATTERNS);
    if (owned) return { action: "owned", reason: owned };
    if (item.trackedDownloadState === "importFailed") return { action: "parked", reason: "Lidarr could not import it" };
    if (item.trackedDownloadStatus === "warning" && ["importPending", "importBlocked"].includes(item.trackedDownloadState)) {
        return { action: "parked", reason: messages[0] ?? "Lidarr could not import it" };
    }
    return null;
}

/** Records that this caller handles the download; false when another already does. */
async function claimDownload(downloadId: string, reason: string): Promise<boolean> {
    const claim = await prisma.handledDownload.createMany({
        data: [{ downloadId, reason }],
        skipDuplicates: true,
    });
    return claim.count > 0;
}

/**
 * Tells Lidarr a download it grabbed for one album and already imported failed, once per download, as
 * its own "mark as failed" does: the release is blocklisted and Lidarr searches again. False for a bundle
 * or a download Lidarr has no grab for. Lidarr's error is passed on so the caller's event is retried.
 */
export async function failImportedDownload(downloadId: string, reason: string): Promise<boolean> {
    if (!(await claimDownload(downloadId, reason))) return false;
    try {
        if (await lidarrService.markDownloadFailed(downloadId)) return true;
    } catch (error) {
        await prisma.handledDownload.deleteMany({ where: { downloadId } });
        throw error;
    }
    await prisma.handledDownload.deleteMany({ where: { downloadId } });
    return false;
}

/**
 * Remove a download from Lidarr, blocklisting its release unless told not to;
 * with searchAgain Lidarr looks for another. False when another caller already
 * removed it, it is not in the queue, or Lidarr refused.
 */
export async function removeFailedDownload(
    downloadId: string,
    reason: string,
    opts: {
        searchAgain: boolean;
        blocklist?: boolean;
        item?: { id: number; title?: string };
        removeFromClient?: boolean;
    }
): Promise<boolean> {
    if (!(await claimDownload(downloadId, reason))) return false;

    const stillQueued = async () => (await lidarrService.getQueueItems()).find((q) => q.downloadId === downloadId);
    let removed = false;
    try {
        const target = opts.item ?? (await stillQueued());
        if (target) {
            removed = await lidarrService.removeQueueItem(target, {
                blocklist: opts.blocklist ?? true,
                skipRedownload: !opts.searchAgain,
                ...(opts.removeFromClient === false ? { removeFromClient: false } : {}),
            });
        }
    } catch (error: any) {
        logger.warn(`[LIDARR] Could not remove download ${downloadId}: ${error.message}`);
    }
    // Lidarr can remove the download and the reply still go missing; the claim
    // stays when the download has left the queue, so Lidarr's report of this
    // removal is never counted as a new failure.
    if (!removed) {
        removed = await stillQueued().then((item) => !item, () => false);
    }
    if (!removed) {
        await prisma.handledDownload.deleteMany({ where: { downloadId } });
    }
    return removed;
}

/** Turn a single-track post away as soon as Lidarr grabs it, when Kima removes junk. */
export async function rejectSingleTrackPost(downloadId: string, releaseTitle?: string): Promise<boolean> {
    if (!releaseTitle || !isSingleTrackPost(releaseTitle)) return false;
    if (!(await removesJunk())) return false;
    logger.debug(`[LIDARR] Rejecting single-track post: ${releaseTitle}`);
    await removeFailedDownload(downloadId, "Single-track post", { searchAgain: true });
    return true;
}

/** Whether Kima removes junk downloads itself (Settings, under Sources > Lidarr), or leaves them to the user's own setup. */
async function removesJunk(): Promise<boolean> {
    return (await getSystemSettings())?.lidarrRemoveJunk ?? true;
}

async function ownedDownloadIds(): Promise<Set<string>> {
    const jobs = await prisma.downloadJob.findMany({
        where: { status: "processing" },
        select: { lidarrRef: true, metadata: true },
    });
    const ids = new Set<string>();
    for (const job of jobs) {
        if (job.lidarrRef) ids.add(job.lidarrRef);
        for (const id of ((job.metadata as any)?.previousDownloadIds ?? []) as string[]) ids.add(id);
    }
    return ids;
}

/** `albums`: every album Lidarr's queue lists for the item's download, one for each album of a bundle. */
async function settle(item: LidarrQueueItem, verdict: QueueVerdict, removeJunk: boolean, albums: number[]): Promise<boolean> {
    const { downloadId } = item;
    if (verdict.action === "parked" || ((verdict.action === "junk" || verdict.action === "reject") && !removeJunk)) {
        await simpleDownloadManager.onImportParked(downloadId, verdict.reason);
        return false;
    }
    if (verdict.action === "reject") {
        return removeFailedDownload(downloadId, verdict.reason, { searchAgain: true, item });
    }
    if (verdict.action === "owned") {
        // A bundle import ends "not an upgrade" because Kima already owned
        // SOME albums in it; the torrent also carries the albums Kima asked
        // for. Detaching the queue item without deleting the data keeps it
        // seeding, which tracker-ratio rules on bundle indexers require.
        const jobs = await prisma.downloadJob.findMany({
            where: {
                status: "processing",
                OR: [{ lidarrRef: downloadId }, { metadata: { path: ["previousDownloadIds"], array_contains: [downloadId] } }],
            },
            select: { metadata: true, lidarrAlbumId: true },
        });
        const bundle = jobs.some((job) => (job.metadata as any)?.grabbedAsBundle);
        // Lidarr's queue can list a download with no album; the jobs know theirs.
        const covered = [...new Set([...albums, ...jobs.map((job) => job.lidarrAlbumId).filter((id): id is number => !!id)])];
        // Lidarr is asked first whether each album is whole: without its answer
        // the download stays for the next sweep rather than leave jobs undecided.
        try {
            for (const albumId of covered) await lidarrService.albumWhole(albumId);
        } catch (error: any) {
            logger.warn(`[LIDARR] Owned download ${downloadId} left for the next sweep: ${error.message}`);
            return false;
        }
        const removed = await removeFailedDownload(downloadId, verdict.reason, {
            searchAgain: false,
            blocklist: false,
            item,
            removeFromClient: !bundle,
        });
        // The download brought nothing new: each album of it is done if Lidarr
        // holds it whole, otherwise this release failed it (Lidarr's reason).
        if (removed) {
            for (const albumId of covered) {
                await simpleDownloadManager.onDownloadComplete(downloadId, undefined, albumId, undefined, 0, verdict.reason).catch((error) => {
                    logger.warn(`[LIDARR] Album ${albumId} of ${downloadId} left to the watcher: ${error.message}`);
                });
            }
        }
        return removed;
    }
    const { searchAgain } = await simpleDownloadManager.onImportFailed(downloadId, verdict.reason);
    return removeFailedDownload(downloadId, verdict.reason, { searchAgain, item });
}

/**
 * Judge every queue item that belongs to a Kima job and act on it. Uses the
 * watcher's snapshot of the queue when given one. Returns how many were removed.
 */
export async function sweepFailedDownloads(snapshot?: ReconciliationSnapshot | null): Promise<{ removed: number }> {
    if (await sourcePauseController.isPaused("lidarr")) return { removed: 0 };
    const owned = await ownedDownloadIds();
    if (owned.size === 0) return { removed: 0 };

    const removeJunk = await removesJunk();
    // Lidarr lists a bundle once per album, every record with the download's
    // state; the first speaks for it, and all of them name its albums.
    const records = snapshot ? snapshot.queueItems : await lidarrService.getQueueItems();
    const byDownload = new Map<string, LidarrQueueItem[]>();
    for (const record of records) byDownload.set(record.downloadId, [...(byDownload.get(record.downloadId) ?? []), record]);
    let removed = 0;
    for (const [downloadId, [item, ...rest]] of byDownload) {
        if (!owned.has(downloadId)) continue;
        const verdict = judgeQueueItem(item);
        const albums = [item, ...rest].map((record) => record.albumId).filter((id): id is number => !!id);
        if (verdict && (await settle(item, verdict, removeJunk, albums))) removed++;
    }
    return { removed };
}
