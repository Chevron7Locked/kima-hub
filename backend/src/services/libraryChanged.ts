/**
 * When the library a client lists last changed, the one value Subsonic's `lastModified` serves. A client compares it with
 * the one it holds and refetches its artists only when it moved, so it moves only for what a client lists: a scan that
 * added, changed, flagged missing, retired or flagged corrupt a library song (workers/processors/scanProcessor.ts), a
 * person or job that deleted or moved library songs, albums or artists (routes/library, the Discover lifecycle, prune,
 * refile, data integrity), and a person's edit of a name shown (routes/enrichment.ts). Analysis writes, Discover songs
 * and artist syncs do not move it, and it never goes backwards. It is stored in the system settings, so every process reads the same one.
 */
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { saveSystemSettings } from "../utils/systemSettings";

/** The moment of the last change, in milliseconds since the epoch; 0 before settings exist. */
export async function libraryChangedAt(): Promise<number> {
    const row = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { libraryChangedAt: true } });
    return row?.libraryChangedAt?.getTime() ?? 0;
}

/**
 * Records that the library a client lists changed, at `at` (now). A time before the one already stored changes nothing,
 * so a clock that stepped back, or two writers, cannot make a client see the library as older. Answers the time now stored.
 */
export async function markLibraryChanged(at: Date = new Date()): Promise<Date> {
    const current = await libraryChangedAt();
    const moved = new Date(Math.max(at.getTime(), current));
    if (moved.getTime() !== current) await saveSystemSettings({ libraryChangedAt: moved });
    return moved;
}

/**
 * `markLibraryChanged` for a change that is already done: a marker that cannot be written is logged and does not undo or
 * fail the removal, move or scan that happened. `what` names the change in that log line.
 */
export async function markLibraryChangedQuietly(what: string): Promise<void> {
    await markLibraryChanged().catch((e) => logger.error(`Failed to record the library change (${what}):`, e));
}
