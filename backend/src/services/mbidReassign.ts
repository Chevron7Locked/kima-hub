/**
 * MBID reassignment shared by the editor routes, enrichment and identification. Unique
 * violations become DuplicateMbidError (409); an unchanged value or a missing row is a no-op.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { forgetOwnedIndex } from "./discovery/ownedIndexVersion";

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
 * Where an album's rgMbid came from (`Album.rgMbidSource`): the files' tags, identification's
 * AcoustID vote, the manual album enrich's name search, or a person in the editor.
 */
export type RgMbidSource = "tag" | "acoustid" | "search" | "editor";

/** Ids a file's own tag may replace: chosen by Kima, not by the files or a person. */
export const REPLACEABLE_SOURCES: readonly RgMbidSource[] = ["acoustid", "search"];

/** Whether an album's id came from Kima's own choice, so the files' tag may replace it. */
export const isKimaChosen = (source: string | null | undefined): boolean =>
    (REPLACEABLE_SOURCES as readonly string[]).includes(source ?? "");

/** How much an album's id is to be trusted, by where it came from; no source is a tag (older rows). */
const sourceStrength = (source: string | null | undefined) =>
    source === "editor" ? 3 : source == null || source === "tag" ? 2 : 1;

export type MoveClient = Pick<Prisma.TransactionClient, "album" | "ownedAlbum" | "discoveryAlbum" | "discoverExclusion" | "$executeRaw">;

/** Which ownership source protects an artist best (dataIntegrity, discover's fix-tagging). */
const OWNERSHIP_RANK = ["native_scan", "discovery_liked"];
export const ownershipRank = (source: string) => {
    const rank = OWNERSHIP_RANK.indexOf(source);
    return rank === -1 ? OWNERSHIP_RANK.length : rank;
};

/**
 * Change an album's rgMbid in one transaction, and move every row keyed on the old id with it.
 * Ownership rows keep their source, whichever artist holds them; a clash keeps the more
 * protective source; none is created. `expectedOld` makes the change compare-and-set: false
 * when the album no longer has it, or already has the new id. A taken id throws DuplicateMbidError.
 */
export async function reassignAlbumRgMbid(
    albumId: string,
    newRgMbid: string,
    opts: { source?: RgMbidSource | null; expectedOld?: string } = {}
): Promise<boolean> {
    const moved = await prisma.$transaction((tx) => moveAlbumRgMbid(tx, albumId, newRgMbid, opts));
    if (moved) forgetOwnedIndex();
    return moved;
}

export async function moveAlbumRgMbid(
    tx: MoveClient,
    albumId: string,
    newRgMbid: string,
    opts: { source?: RgMbidSource | null; expectedOld?: string }
): Promise<boolean> {
    const album = await tx.album.findUnique({ where: { id: albumId }, select: { rgMbid: true, rgMbidSource: true } });
    if (!album) {
        logger.warn(`Album ${albumId} not found — skipping rgMbid reassign`);
        return false;
    }
    const oldRgMbid = album.rgMbid;
    if (oldRgMbid === newRgMbid) {
        // The same id confirmed by a stronger source (a tag, a person) takes that source.
        if (opts.source && sourceStrength(opts.source) > sourceStrength(album.rgMbidSource)) {
            await tx.album.updateMany({
                where: { id: albumId, rgMbid: newRgMbid, rgMbidSource: album.rgMbidSource },
                data: { rgMbidSource: opts.source },
            });
        }
        return false;
    }
    if (opts.expectedOld !== undefined && oldRgMbid !== opts.expectedOld) return false;

    // Album.rgMbid is @unique, so a duplicate collides here first.
    try {
        // Compare-and-set on the id and its source as read: a change meanwhile (a person's edit
        // included) is never overwritten.
        const moved = await tx.album.updateMany({
            where: { id: albumId, rgMbid: oldRgMbid, rgMbidSource: album.rgMbidSource },
            data: { rgMbid: newRgMbid, rgMbidSource: opts.source ?? null },
        });
        if (moved.count === 0) return false;
    } catch (err: any) {
        if (err.code === "P2002") throw new DuplicateMbidError("album", newRgMbid);
        throw err;
    }

    await moveOwnership(tx, oldRgMbid, newRgMbid);
    await moveDiscoveryAlbums(tx, oldRgMbid, newRgMbid);
    await moveDiscoverExclusions(tx, oldRgMbid, newRgMbid);
    return true;
}

/** `ownershipRank` as SQL over an `OwnedAlbum` source column, so a clash is settled inside the write that meets it. */
const ownershipRankSql = (source: Prisma.Sql) =>
    Prisma.sql`(CASE ${source} ${Prisma.join(OWNERSHIP_RANK.map((name, rank) => Prisma.sql`WHEN ${name} THEN ${rank}::int`), " ")} ELSE ${OWNERSHIP_RANK.length}::int END)`;

/**
 * One write for an ownership move: the rows are deleted and put back under their new key in a single statement. The
 * delete says what this writer took, so a row a concurrent writer removed or already moved hands nothing on and a second
 * call finds nothing. A row at the new key (held before, or written by another transaction meanwhile) is not an error:
 * the more protective source (`ownershipRank`) stands. `taken` is the CTE that names the rows deleted.
 */
function moveOwnedRows(tx: Pick<MoveClient, "$executeRaw">, taken: Prisma.Sql, artistId: Prisma.Sql, rgMbid: string) {
    const held = Prisma.raw('"OwnedAlbum".source');
    const arriving = Prisma.raw("EXCLUDED.source");
    return tx.$executeRaw`
        WITH taken AS (${taken})
        INSERT INTO "OwnedAlbum" ("artistId", "rgMbid", source)
        SELECT ${artistId}, ${rgMbid}::text, taken.source FROM taken
        ON CONFLICT ("artistId", "rgMbid") DO UPDATE
        SET source = CASE WHEN ${ownershipRankSql(arriving)} < ${ownershipRankSql(held)} THEN EXCLUDED.source ELSE "OwnedAlbum".source END`;
}

/** Every artist's ownership row for the old id moves to the new one, keeping its source; on a clash the more protective stays. */
export async function moveOwnership(tx: Pick<MoveClient, "$executeRaw">, oldRgMbid: string, newRgMbid: string): Promise<void> {
    if (oldRgMbid === newRgMbid) return;
    await moveOwnedRows(
        tx,
        Prisma.sql`DELETE FROM "OwnedAlbum" WHERE "rgMbid" = ${oldRgMbid} RETURNING "artistId", source`,
        Prisma.sql`taken."artistId"`,
        newRgMbid,
    );
}

/** One artist's ownership of an album id becomes another's; on a clash the more protective source stays. */
export async function moveOwnerArtist(tx: Pick<MoveClient, "$executeRaw">, fromArtistId: string, toArtistId: string, rgMbid: string): Promise<void> {
    if (fromArtistId === toArtistId) return;
    await moveOwnedRows(
        tx,
        Prisma.sql`DELETE FROM "OwnedAlbum" WHERE "artistId" = ${fromArtistId} AND "rgMbid" = ${rgMbid} RETURNING source`,
        Prisma.sql`${toArtistId}::text`,
        rgMbid,
    );
}

/**
 * DiscoveryAlbum rows move to the new id. Rows whose (userId, weekStartDate, newRgMbid) slot is
 * taken are left and logged, since a unique violation would abort the transaction; a racing
 * insert still can, and identification retries later.
 */
export async function moveDiscoveryAlbums(tx: MoveClient, oldRgMbid: string, newRgMbid: string): Promise<void> {
    const staleRows = await tx.discoveryAlbum.findMany({
        where: { rgMbid: oldRgMbid },
        select: { id: true, userId: true, weekStartDate: true },
    });
    if (staleRows.length === 0) return;
    const takenSlots = await tx.discoveryAlbum.findMany({
        where: {
            rgMbid: newRgMbid,
            OR: staleRows.map((r) => ({ userId: r.userId, weekStartDate: r.weekStartDate })),
        },
        select: { userId: true, weekStartDate: true },
    });
    const taken = new Set(takenSlots.map((t) => `${t.userId}|${t.weekStartDate.toISOString()}`));
    const movableIds: string[] = [];
    for (const row of staleRows) {
        if (taken.has(`${row.userId}|${row.weekStartDate.toISOString()}`)) {
            logger.warn(
                `[rgMbid-reassign] DiscoveryAlbum ${row.id} kept on stale ${oldRgMbid}: ` +
                    `user ${row.userId} already has a discovery row for ${newRgMbid} in the same week`
            );
        } else {
            movableIds.push(row.id);
        }
    }
    if (movableIds.length > 0) {
        await tx.discoveryAlbum.updateMany({ where: { id: { in: movableIds } }, data: { rgMbid: newRgMbid } });
    }
}

/** A user's "don't suggest this album" moves too; a clash keeps the later dates. */
export async function moveDiscoverExclusions(tx: MoveClient, oldRgMbid: string, newRgMbid: string): Promise<void> {
    const rows = await tx.discoverExclusion.findMany({ where: { albumMbid: oldRgMbid } });
    for (const row of rows) {
        const clash = await tx.discoverExclusion.findUnique({
            where: { userId_albumMbid: { userId: row.userId, albumMbid: newRgMbid } },
        });
        if (clash) {
            await tx.discoverExclusion.update({
                where: { id: clash.id },
                data: {
                    expiresAt: row.expiresAt > clash.expiresAt ? row.expiresAt : clash.expiresAt,
                    lastSuggestedAt: row.lastSuggestedAt > clash.lastSuggestedAt ? row.lastSuggestedAt : clash.lastSuggestedAt,
                },
            });
            await tx.discoverExclusion.delete({ where: { id: row.id } });
        } else {
            await tx.discoverExclusion.update({ where: { id: row.id }, data: { albumMbid: newRgMbid } });
        }
    }
}

/**
 * The artist's mbid change inside the caller's transaction (or on the plain client), so it commits with the rest of an
 * edit. It does not forget the owned index: whoever commits does, once. A missing artist throws P2025, as any update does.
 */
export async function moveArtistMbid(
    db: Pick<Prisma.TransactionClient, "artist">,
    artistId: string,
    newMbid: string
): Promise<void> {
    await db.artist.update({
        where: { id: artistId },
        data: { mbid: newMbid },
    }).catch((err: any) => {
        if (err.code === "P2002") {
            throw new DuplicateMbidError("artist", newMbid);
        }
        throw err;
    });
}
