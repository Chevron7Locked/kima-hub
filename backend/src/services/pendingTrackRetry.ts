/**
 * Retrying a playlist's pending song through Soulseek. Each retry is a download job, so it shows in Activity: it ends
 * completed with the file (and a scan is asked for, which puts the song on the playlist), or failed with the reason.
 * Used by the playlist's retry and retry-all and by a retry of a failed download in Activity.
 */

import type { DownloadJob, PlaylistPendingTrack } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { soulseekService } from "./soulseek";
import { requestScan } from "../workers/scanRequest";

type Matches = Awaited<ReturnType<typeof soulseekService.searchTrack>>["allMatches"];

const NO_ALBUM = "Unknown Album";
export const SOULSEEK_UNAVAILABLE = "Soulseek is turned off or not set up";

/**
 * The music folder Soulseek downloads into, or the reason Soulseek cannot fetch anything here. Soulseek's own check
 * covers its off switch and an account set by environment variable.
 */
export async function soulseekTarget(): Promise<{ musicPath: string } | { problem: string }> {
    const settings = await getSystemSettings();
    if (!settings?.musicPath) return { problem: "Music path not configured" };
    if (!(await soulseekService.isAvailable())) return { problem: SOULSEEK_UNAVAILABLE };
    return { musicPath: settings.musicPath };
}

/** The job a retry of this pending song is recorded on. */
export function retryJobTarget(pendingTrack: PlaylistPendingTrack): string {
    return pendingTrack.albumMbid || pendingTrack.artistMbid || `pendingTrack:${pendingTrack.id}`;
}

export function createRetryJob(userId: string, pendingTrack: PlaylistPendingTrack, extra: Record<string, unknown> = {}) {
    return prisma.downloadJob.create({
        data: {
            userId,
            subject: `${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
            type: "track",
            targetMbid: retryJobTarget(pendingTrack),
            artistMbid: pendingTrack.artistMbid,
            status: "processing",
            attempts: 1,
            startedAt: new Date(),
            metadata: {
                downloadType: "pending-track-retry",
                source: "soulseek",
                playlistId: pendingTrack.playlistId,
                pendingTrackId: pendingTrack.id,
                spotifyArtist: pendingTrack.spotifyArtist,
                spotifyTitle: pendingTrack.spotifyTitle,
                spotifyAlbum: pendingTrack.spotifyAlbum,
                albumMbid: pendingTrack.albumMbid,
                ...extra,
            },
        },
    });
}

export async function failRetryJob(jobId: string, error: string): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: { status: "failed", error, completedAt: new Date() },
    });
}

export const NO_SOURCES = "No matching files found";

/**
 * Soulseek's files for the job's pending song. With none, or when the search itself fails, the job is failed with the
 * reason; none returns empty, a failed search throws.
 */
export async function findSources(job: DownloadJob, pendingTrack: PlaylistPendingTrack): Promise<Matches> {
    try {
        const result = await soulseekService.searchTrack(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle,
            pendingTrack.spotifyAlbum !== NO_ALBUM ? pendingTrack.spotifyAlbum : undefined
        );
        if (result.found && result.allMatches.length > 0) return result.allMatches;
        await failRetryJob(job.id, NO_SOURCES);
        return [];
    } catch (error: any) {
        await failRetryJob(job.id, error?.message || "Soulseek search failed").catch(() => undefined);
        throw error;
    }
}

/**
 * Downloads the best of the files and records the outcome on the job; a finished download asks for a scan of its
 * album. Never throws: a failure is the job's failed state.
 */
export async function downloadSources(
    job: DownloadJob,
    pendingTrack: PlaylistPendingTrack,
    matches: Matches,
    musicPath: string,
    scanSource: string
): Promise<void> {
    try {
        const result = await soulseekService.downloadBestMatch(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle,
            // Without an album the song is filed in a folder named after the artist.
            pendingTrack.spotifyAlbum !== NO_ALBUM ? pendingTrack.spotifyAlbum : pendingTrack.spotifyArtist,
            matches,
            musicPath
        );
        if (!result.success) {
            await failRetryJob(job.id, result.error || "Download failed");
            return;
        }
        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "completed",
                completedAt: new Date(),
                metadata: { ...(job.metadata as Record<string, unknown>), filePath: result.filePath },
            },
        });
        await requestScan({
            userId: job.userId,
            source: scanSource,
            albumMbid: pendingTrack.albumMbid || undefined,
            artistMbid: pendingTrack.artistMbid || undefined,
            priority: 1,
            removeOnComplete: true,
        }).catch((error) => logger.error(`[Pending retry] Could not queue a scan for job ${job.id}:`, error));
    } catch (error: any) {
        logger.error(`[Pending retry] Download of job ${job.id} failed:`, error);
        await failRetryJob(job.id, error?.message || "Download exception").catch(() => undefined);
    }
}
