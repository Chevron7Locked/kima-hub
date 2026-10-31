import type { Job } from "bullmq";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { notificationService } from "../../services/notificationService";
import { refileLibrary, type RefileResult } from "../../services/albumRefile";

export interface RefileJobData {
    /** The admin who asked; the outcome goes to their notification tray. */
    userId: string;
}

const REFILE_RESULT_KEY = "library-refile";

function refileSummary(r: RefileResult): string {
    return [
        ...(r.artistsRenamed ? [`${r.artistsRenamed} artists given back their full names`] : []),
        `${r.albumsMoved} albums moved, ${r.albumsMerged} joined the right artist's copy`,
        `${r.artistsRemoved} empty artists removed`,
        ...(r.keptEdited ? [`${r.keptEdited} left as a person edited them`] : []),
        ...(r.songsUnreadable ? [`${r.songsUnreadable} songs could not be read; their albums stayed where they are`] : []),
        ...(r.albumsFailed ? [`${r.albumsFailed} albums could not be re-filed (see the server log); run it again to retry them`] : []),
    ].join("; ");
}

/**
 * The album re-file, run on the scan queue. A run counts as done (closing the 1.12 release item) only when songs
 * were read and every album could be re-filed.
 */
export async function processRefile(job: Job<RefileJobData>): Promise<RefileResult> {
    const { userId } = job.data;
    const tell = (type: "system" | "error", title: string, message: string) =>
        notificationService
            .create({ userId, type, title, message, groupKey: REFILE_RESULT_KEY, renotify: true })
            .catch((e) => logger.error(`[RefileJob ${job.id}] Could not record the outcome:`, e));

    let result: RefileResult;
    try {
        result = await refileLibrary(config.music.musicPath);
    } catch (error: any) {
        logger.error(`[RefileJob ${job.id}] Failed:`, error);
        await tell("error", "Re-filing albums failed", error?.message ?? String(error));
        throw error;
    }

    if (result.songsRead === 0 && result.songsUnreadable > 0) {
        await tell("error", "Re-filing albums found no songs to read", `None of ${result.songsUnreadable} songs could be read. Is the music drive mounted?`);
        return result;
    }
    if (result.albumsFailed === 0) {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", albumsRefiledAt: new Date() }, update: { albumsRefiledAt: new Date() } });
    }
    await tell("system", "Albums re-filed by their tags", refileSummary(result));
    return result;
}
