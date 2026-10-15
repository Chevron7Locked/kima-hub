import type { Job } from "bullmq";
import { logger } from "../../utils/logger";
import { discoverWeeklyService } from "../../services/discoverWeekly";
import { eventBus } from "../../services/eventBus";
import { prisma } from "../../utils/db";
import { ACQUIRE_REFUSED, mayAcquire } from "../../utils/acquirePermission";

export interface DiscoverJobData {
    userId: string;
}

export interface DiscoverJobResult {
    success: boolean;
    playlistName: string;
    songCount: number;
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
        return { success: false, playlistName: "", songCount: 0, error: user ? ACQUIRE_REFUSED : "No such user" };
    }

    logger.debug(
        `[DiscoverJob ${job.id}] Generating Discover Weekly for user ${userId}`
    );

    await job.updateProgress(10);

    try {
        // generatePlaylist has no progress callback; progress is reported at key stages.
        await job.updateProgress(20);

        logger.debug(
            `[DiscoverJob ${job.id}] Calling discoverWeeklyService.generatePlaylist...`
        );
        const result = await discoverWeeklyService.generatePlaylist(userId);

        logger.debug(`[DiscoverJob ${job.id}] Result:`, {
            success: result.success,
            playlistName: result.playlistName,
            songCount: result.songCount,
            batchId: result.batchId,
        });

        if (result.batchId) {
            eventBus.emit({
                type: "discover:progress",
                userId,
                payload: { batchId: result.batchId, status: "downloading", completed: 0, failed: 0, total: result.songCount, progress: 0 },
            });
        }

        await job.updateProgress(100); // Complete

        logger.debug(
            `[DiscoverJob ${job.id}] Generation complete: SUCCESS`
        );

        return {
            success: result.success,
            playlistName: result.playlistName,
            songCount: result.songCount,
            batchId: result.batchId,
        };
    } catch (error: any) {
        logger.error(
            `[DiscoverJob ${job.id}] Generation failed with exception:`,
            error
        );
        logger.error(`[DiscoverJob ${job.id}] Stack trace:`, error.stack);

        // Re-throw so BullMQ can track the failure and trigger retries
        throw error;
    }
}
