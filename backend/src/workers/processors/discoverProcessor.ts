import type { Job } from "bullmq";
import { logger } from "../../utils/logger";
import { discoverWeeklyService } from "../../services/discoverWeekly";
import { eventBus } from "../../services/eventBus";

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

    logger.debug(
        `[DiscoverJob ${job.id}] Generating Discover Weekly for user ${userId}`
    );

    await job.updateProgress(10);

    try {
        // Note: The discoverWeeklyService.generatePlaylist doesn't have progress callback yet
        // For now, we'll just report progress at key stages
        await job.updateProgress(20); // Starting generation

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
