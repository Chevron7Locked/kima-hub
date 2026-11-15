import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";

/** How long a create's `Idempotency-Key` is remembered. */
export const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_KEY_LENGTH = 128;

type NewPlaylist = { name: string; isPublic: boolean };

/** The row as the API shows it: the key is bookkeeping, not part of the playlist. */
function shown<T extends { idempotencyKey: string | null }>(row: T): Omit<T, "idempotencyKey"> {
    const { idempotencyKey: _key, ...playlist } = row;
    return playlist;
}

/**
 * Makes `userId` a playlist. With a key, a repeat of the same key by the same person within 24 hours returns the playlist
 * the first one made (whatever name it carries now), so a retry after a lost answer makes no second one. Without a key it
 * always makes a new one.
 */
export async function createPlaylist(userId: string, data: NewPlaylist, key?: string) {
    if (!key) return shown(await prisma.playlist.create({ data: { userId, ...data } }));

    // Forget an expired key without touching the old playlist's own fields (a normal update would bump `updatedAt`).
    const expired = new Date(Date.now() - KEY_LIFETIME_MS);
    await prisma.$executeRaw`UPDATE "Playlist" SET "idempotencyKey" = NULL WHERE "userId" = ${userId} AND "idempotencyKey" = ${key} AND "createdAt" < ${expired}`;

    const made = () => prisma.playlist.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
    const existing = await made();
    if (existing) return shown(existing);

    try {
        return shown(await prisma.playlist.create({ data: { userId, ...data, idempotencyKey: key } }));
    } catch (error) {
        // The same key arrived at the same moment and won the insert.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            const winner = await made();
            if (winner) return shown(winner);
        }
        throw error;
    }
}
