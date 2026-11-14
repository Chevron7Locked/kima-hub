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
