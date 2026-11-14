/**
 * Retrying a playlist's pending song through Soulseek. Each retry is a download job, so it shows in Activity: it ends
 * completed with the file (and a scan is asked for, which puts the song on the playlist), or failed with the reason.
 * Used by the playlist's retry and retry-all and by a retry of a failed download in Activity.
 */

import type { DownloadJob, PlaylistPendingTrack } from "@prisma/client";
import { logger } from "../utils/logger";
import { config } from "../config";
import { soulseekService } from "./soulseek";
import * as downloadJobs from "./downloads/jobs";
import { requestScan } from "../workers/scanRequest";

type Matches = Awaited<ReturnType<typeof soulseekService.searchTrack>>["allMatches"];

const NO_ALBUM = "Unknown Album";
const SOULSEEK_UNAVAILABLE = "Soulseek is turned off or not set up";

/**
 * The music folder Soulseek downloads into, or the reason Soulseek cannot fetch anything here. Soulseek's own check
 * covers its off switch and an account set by environment variable.
 */
export async function soulseekTarget(): Promise<{ musicPath: string } | { problem: string }> {
    if (!(await soulseekService.isAvailable())) return { problem: SOULSEEK_UNAVAILABLE };
    return { musicPath: config.music.musicPath };
}

/**
 * The key a retry of this pending song is recorded under: one per song, so a song's running retry never stands in for
 * its album-mates' (a Spotify import puts many songs of one album on a playlist).
 */
export function retryJobTarget(pendingTrack: PlaylistPendingTrack): string {
    return `pendingTrack:${pendingTrack.id}`;
}

function retryJobInput(
    userId: string,
    pendingTrack: PlaylistPendingTrack,
    discoveryBatchId: string | null,
    extra: Record<string, unknown> = {}
): downloadJobs.CreateInput & { targetMbid: string } {
    return {
        userId,
        subject: `${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
        type: "track",
        targetMbid: retryJobTarget(pendingTrack),
        artistMbid: pendingTrack.artistMbid,
        discoveryBatchId,
        status: "processing",
        metadata: {
            downloadType: "pending-track-retry",
            source: "soulseek",
            playlistId: pendingTrack.playlistId,
            pendingTrackId: pendingTrack.id,
            spotifyArtist: pendingTrack.spotifyArtist,
            spotifyTitle: pendingTrack.spotifyTitle,
            spotifyAlbum: pendingTrack.spotifyAlbum,
            albumMbid: pendingTrack.albumMbid,
            ...(extra as Record<string, never>),
        },
    };
}

/**
 * Opens the retry's job inside the transaction `retryOnce` runs, together with the clearing of the failed one. Pass the
 * failed job's Discover batch so the replacement stays in it. A song with a job already running makes the insert meet
 * the active-track index, which `retryOnce` answers.
 */
export function createRetryJob(
    userId: string,
    pendingTrack: PlaylistPendingTrack,
    { extra = {}, db, discoveryBatchId = null }: {
        extra?: Record<string, unknown>;
        db?: Parameters<typeof downloadJobs.create>[1];
        discoveryBatchId?: string | null;
    } = {}
) {
    return downloadJobs.create(retryJobInput(userId, pendingTrack, discoveryBatchId, extra), db);
}

/**
 * Opens the retry's job from the playlist, with no failed job to clear: the song's running job when it already has one
 * (another retry, from the playlist or Activity), otherwise a new one. Two retries of one song at once make one job.
 */
export function openRetryJob(userId: string, pendingTrack: PlaylistPendingTrack) {
    return downloadJobs.createOnce(retryJobInput(userId, pendingTrack, null));
}

export async function failRetryJob(jobId: string, error: string): Promise<void> {
    await downloadJobs.fail([{ id: jobId }], error);
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
 * album, then completes the job. Never throws: a failure is the job's failed state.
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
        // The scan is asked for before the job reads completed, so nobody who sees it completed finds the scan still to come.
        await requestScan({
            userId: job.userId,
            source: scanSource,
            albumMbid: pendingTrack.albumMbid || undefined,
            artistMbid: pendingTrack.artistMbid || undefined,
            priority: 1,
            removeOnComplete: true,
        }).catch((error) => logger.error(`[Pending retry] Could not queue a scan for job ${job.id}:`, error));
        // A job cancelled while the file downloaded stays cancelled; the file is on disk, so the scan above was asked for anyway.
        const settled = await downloadJobs.complete([job], { filePath: result.filePath });
        if (settled.length === 0) logger.debug(`[Pending retry] Job ${job.id} was settled before its download finished`);
    } catch (error: any) {
        logger.error(`[Pending retry] Download of job ${job.id} failed:`, error);
        await failRetryJob(job.id, error?.message || "Download exception").catch(() => undefined);
    }
}
