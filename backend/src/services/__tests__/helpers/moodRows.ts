import { prisma } from "../../../utils/db";

/**
 * Clears what a mood or matching test wrote. The statistics and every sound vector go too, not just the rows
 * under `prefix`, because the tests' counts are exact and a vector left by another file would change them.
 */
export async function removeMoodRows(prefix: string, { matchingState = false } = {}) {
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    if (matchingState) await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
    await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${prefix}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${prefix}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${prefix}%'`);
}

/**
 * Until a statement containing `fragment` waits on a lock. Watched from outside any transaction, which would see one
 * snapshot of the activity throughout; given up well inside a transaction's timeout, so a statement that never waits
 * fails the test.
 */
export async function untilWaiting(fragment: string) {
    const giveUp = Date.now() + 20_000;
    for (;;) {
        if (Date.now() > giveUp) throw new Error(`No statement with ${fragment} waited on a lock`);
        const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND position($1 IN query) > 0`,
            fragment,
        );
        if (n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
