/**
 * Shared MBID reassignment helper
 *
 * Provides canonical MBID/rgMbid reassignment with:
 * - Prisma P2002 -> DuplicateMbidError translation (HTTP 409 for routes)
 * - OwnedAlbum row migration (delete old, upsert new) when Album.rgMbid changes
 * - No-op when the new value equals the current value
 * - No-op when the entity doesn't exist
 *
 * Used by BOTH the editor routes AND the enrichment service.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/**
 * Thrown when a unique MBID collision is detected.
 * Carries the entity type and the colliding value for structured error handling.
 */
export class DuplicateMbidError extends Error {
    public readonly entityType: string;
    public readonly mbidValue: string;

    constructor(entityType: string, mbidValue: string) {
        super(`MBID ${mbidValue} is already in use by another ${entityType}`);
        this.entityType = entityType;
        this.mbidValue = mbidValue;
        Object.setPrototypeOf(this, DuplicateMbidError.prototype);
    }
}

/**
 * Reassign an album's rgMbid and migrate the associated OwnedAlbum row.
 *
 * Steps inside a single transaction:
 * 1. Read current Album.rgMbid — no-op if album gone or rgMbid unchanged.
 * 2. Update Album.rgMbid to the new value.
 * 3. If rgMbid changed: delete the old OwnedAlbum row (artistId, oldRgMbid),
 *    then upsert the new OwnedAlbum row (artistId, newRgMbid).
 * 4. If P2002 is raised on the upsert, translate to DuplicateMbidError.
 */
export async function reassignAlbumRgMbid(
    albumId: string,
    newRgMbid: string
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        // Step 1: read current rgMbid
        const album = await tx.album.findUnique({
            where: { id: albumId },
            select: { rgMbid: true, artistId: true },
        });

        if (!album) {
            logger.warn(`Album ${albumId} not found — skipping rgMbid reassign`);
            return;
        }

        if (album.rgMbid === newRgMbid) {
            // No change needed
            return;
        }

        const oldRgMbid = album.rgMbid;
        const artistId = album.artistId;

        // Step 2: update Album.rgMbid. Album.rgMbid is @unique, so a duplicate
        // collides HERE first — translate P2002 to DuplicateMbidError (same as Step 3).
        try {
            await tx.album.update({
                where: { id: albumId },
                data: { rgMbid: newRgMbid },
            });
        } catch (err: any) {
            if (err.code === "P2002") {
                throw new DuplicateMbidError("album", newRgMbid);
            }
            throw err;
        }

        // Step 3: migrate OwnedAlbum row
        try {
            // Delete the old OwnedAlbum row
            await tx.ownedAlbum.delete({
                where: {
                    artistId_rgMbid: {
                        artistId,
                        rgMbid: oldRgMbid,
                    },
                },
            });
        } catch (err: any) {
            // Row may not exist (e.g., enrichment-created album without OwnedAlbum)
            if (err.code !== "P2025") {
                throw err;
            }
        }

        // Upsert the new OwnedAlbum row
        try {
            await tx.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId,
                        rgMbid: newRgMbid,
                    },
                },
                create: {
                    artistId,
                    rgMbid: newRgMbid,
                    source: "enrichment",
                },
                update: {},
            });
        } catch (err: any) {
            if (err.code === "P2002") {
                throw new DuplicateMbidError("album", newRgMbid);
            }
            throw err;
        }
    });
}

/**
 * Reassign an artist's mbid.
 *
 * If P2002 is raised (duplicate mbid), translate to DuplicateMbidError.
 */
export async function reassignArtistMbid(
    artistId: string,
    newMbid: string
): Promise<void> {
    await prisma.artist.update({
        where: { id: artistId },
        data: { mbid: newMbid },
    }).catch((err: any) => {
        if (err.code === "P2002") {
            throw new DuplicateMbidError("artist", newMbid);
        }
        throw err;
    });
}
