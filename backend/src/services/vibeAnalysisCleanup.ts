import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const STALE_THRESHOLD_MINUTES = 30; // Longer than audio analysis due to CLAP processing time
export const VIBE_MAX_RETRIES = 3;

class VibeAnalysisCleanupService {
    /**
     * Clean up tracks stuck in "processing" state for vibe embeddings
     * Returns number of tracks reset
     */
    async cleanupStaleProcessing(): Promise<{ reset: number }> {
        const cutoff = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000);

        // Find tracks stuck in processing
        const staleTracks = await prisma.track.findMany({
            where: {
                vibeAnalysisStatus: "processing",
                OR: [
                    { vibeAnalysisStatusUpdatedAt: { lt: cutoff } },
                    {
                        vibeAnalysisStatusUpdatedAt: null,
                        updatedAt: { lt: cutoff },
                    },
                ],
            },
            include: {
                album: {
                    include: {
                        artist: { select: { name: true } },
                    },
                },
            },
        });

        if (staleTracks.length === 0) {
            return { reset: 0 };
        }

        logger.debug(
            `[VibeAnalysisCleanup] Found ${staleTracks.length} stale vibe tracks (processing > ${STALE_THRESHOLD_MINUTES} min)`
        );

        let resetCount: number = 0;

        for (const track of staleTracks) {
            const trackName = `${track.album.artist.name} - ${track.title}`;
            const newRetryCount = (track.vibeAnalysisRetryCount ?? 0) + 1;

            if (newRetryCount > VIBE_MAX_RETRIES) {
                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        vibeAnalysisStatus: "failed",
                        vibeAnalysisError: `Exceeded ${VIBE_MAX_RETRIES} retry attempts`,
                        vibeAnalysisRetryCount: newRetryCount,
                        vibeAnalysisStatusUpdatedAt: new Date(),
                    },
                });
                logger.warn(`[VibeAnalysisCleanup] Permanently failed after ${VIBE_MAX_RETRIES} retries: ${trackName}`);
            } else {
                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        vibeAnalysisStatus: null,
                        vibeAnalysisRetryCount: newRetryCount,
                        vibeAnalysisStatusUpdatedAt: null,
                    },
                });
                logger.debug(`[VibeAnalysisCleanup] Reset for retry (${newRetryCount}/${VIBE_MAX_RETRIES}): ${trackName}`);
            }
            resetCount++;
        }

        return { reset: resetCount };
    }
}

export const vibeAnalysisCleanupService = new VibeAnalysisCleanupService();
