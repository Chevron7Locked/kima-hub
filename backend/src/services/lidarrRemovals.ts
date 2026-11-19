/**
 * The one place Kima removes a download from Lidarr's queue or marks one failed. Each download id is
 * handled at most once. Imports nothing that settles jobs, so the download manager and the queue
 * sweep (`lidarrFailures.ts`) can both use it.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { lidarrService } from "./lidarr";

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
