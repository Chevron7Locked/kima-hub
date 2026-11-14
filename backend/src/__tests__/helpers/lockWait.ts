import { prisma } from "../../utils/db";

/**
 * Until a statement containing `fragment` waits on a lock. Watched from outside any transaction, which would see one
 * snapshot of the activity throughout; given up well inside a transaction's timeout, so a statement that never waits
 * fails the test.
 */
export async function untilLockWait(fragment: string): Promise<void> {
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
