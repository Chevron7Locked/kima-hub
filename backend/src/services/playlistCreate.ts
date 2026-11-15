import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { namedFields, playlistFields } from "./playlistFields";

/** How long a create's `Idempotency-Key` is remembered. */
export const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_KEY_LENGTH = 128;

type NewPlaylist = { name: string; isPublic: boolean };

/** A key came again with a different name or visibility than the create it first named. */
export class KeyParamsMismatch extends Error {
    constructor() {
        super("Idempotency-Key was already used with different parameters");
    }
}

const hashOf = (data: NewPlaylist) => createHash("sha256").update(JSON.stringify([data.name, data.isPublic])).digest("hex");

/**
 * Makes `userId` a playlist. With a key, a repeat of the same key and the same parameters by the same person within 24
 * hours returns the playlist the first one made, so a retry after a lost answer makes no second one; the same key with
 * another name or visibility throws `KeyParamsMismatch` (a playlist made before parameters were kept takes any repeat).
 * Without a key it always makes a new one.
 */
export async function createPlaylist(userId: string, data: NewPlaylist, key?: string) {
    if (!key) return prisma.playlist.create({ data: { userId, ...data }, select: playlistFields });

    // Forget an expired key without touching the old playlist's own fields (a normal update would bump `updatedAt`).
    const expired = new Date(Date.now() - KEY_LIFETIME_MS);
    await prisma.$executeRaw`UPDATE "Playlist" SET "idempotencyKey" = NULL WHERE "userId" = ${userId} AND "idempotencyKey" = ${key} AND "createdAt" < ${expired}`;

    const params = hashOf(data);
    const findByKey = async () => {
        const found = await prisma.playlist.findUnique({
            where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
            select: { ...playlistFields, idempotencyParams: true },
        });
        if (!found) return null;
        if (found.idempotencyParams !== null && found.idempotencyParams !== params) throw new KeyParamsMismatch();
        return namedFields(found);
    };
    const existing = await findByKey();
    if (existing) return existing;

    try {
        return await prisma.playlist.create({
            data: { userId, ...data, idempotencyKey: key, idempotencyParams: params },
            select: playlistFields,
        });
    } catch (error) {
        // The same key arrived at the same moment and won the insert.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            const winner = await findByKey();
            if (winner) return winner;
        }
        throw error;
    }
}
