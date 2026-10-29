import type { Job } from "bullmq";
import { logger } from "../../utils/logger";
import { discoverWeeklyService } from "../../services/discoverWeekly";
import { prisma } from "../../utils/db";
import { ACQUIRE_REFUSED, mayAcquire } from "../../utils/acquirePermission";

export interface DiscoverJobData {
    userId: string;
}

export interface DiscoverJobResult {
    success: boolean;
    /** Album downloads started; the playlist is built once they land and the scan finishes. */
    downloadsQueued: number;
    batchId?: string;
    error?: string;
}

export async function processDiscoverWeekly(
    job: Job<DiscoverJobData>
): Promise<DiscoverJobResult> {
    const { userId } = job.data;

    // Building the playlist downloads albums, so it follows the download rule whoever queued it (the button is
    // gated, but the weekly run queues every user who turned Discover on).
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || !(await mayAcquire(user))) {
        logger.info(`[DiscoverJob ${job.id}] Skipped for ${userId}: ${user ? ACQUIRE_REFUSED : "no such user"}`);
        return { success: false, downloadsQueued: 0, error: user ? ACQUIRE_REFUSED : "No such user" };
    }

    logger.debug(`[DiscoverJob ${job.id}] Generating Discover Weekly for user ${userId}`);
    await job.updateProgress(10);
    try {
        // generatePlaylist answers success or throws; the batch's progress reaches the page from checkBatchCompletion.
        const result = await discoverWeeklyService.generatePlaylist(userId);
        await job.updateProgress(100);
        logger.debug(`[DiscoverJob ${job.id}] ${result.downloadsQueued} album downloads queued (batch ${result.batchId})`);
        return { success: result.success, downloadsQueued: result.downloadsQueued, batchId: result.batchId };
    } catch (error: any) {
        // Thrown on so BullMQ records the failure and retries.
        logger.error(`[DiscoverJob ${job.id}] Generation failed:`, error);
        throw error;
    }
}
