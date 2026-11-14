/**
 * When the library a client lists last changed, the one value Subsonic's `lastModified` serves. A client compares it with
 * the one it holds and refetches its artists only when it moved, so it moves only for what a client lists: a scan that
 * added, changed, flagged missing, retired or flagged corrupt songs (workers/processors/scanProcessor.ts), and a
 * person's edit of a name shown (routes/enrichment.ts). Analysis writes, Discover songs and artist syncs do not move it,
 * and it never goes backwards. It is stored in the system settings, so every process reads the same one.
 */
import { prisma } from "../utils/db";
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
