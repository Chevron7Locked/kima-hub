/**
 * Playlist mutations, each transactional and bulk-shaped. Ordering uses
 * fractional ranks (utils/lexoRank), so a move writes one row and positions
 * cannot collide.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { rankAfter, rankBetween, rankSequence } from "../utils/lexoRank";
import { PLAYABLE_SONG } from "../utils/playableSong";

/** Cap on a single bulk operation, so one request cannot pin a connection. */
const MAX_BULK_TRACKS = 1000;

export interface AddTracksResult {
    added: number;
    /** Already present in the playlist; not an error. */
    duplicates: number;
    /** Requested but not a playable song: unknown, on a Discover album, missing or corrupt. */
    rejected: string[];
}

/**
 * Serialise mutations for one playlist. Read-then-write on max(rank) is only safe if
 * concurrent writers are ordered; a Postgres advisory lock keyed on the playlist does
 * that without a table lock and is released at commit.
 */
export async function lockPlaylist(
    tx: Pick<typeof prisma, "$executeRaw">,
    playlistId: string
): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${playlistId}))`;
}

/** Highest rank across items and pending tracks, which share one key space
 * that no per-table unique index can see across. */
async function maxRank(
    tx: Pick<typeof prisma, "playlistItem" | "playlistPendingTrack">,
    playlistId: string
): Promise<string> {
    const [item, pending] = await Promise.all([
        tx.playlistItem.findFirst({
            where: { playlistId },
            orderBy: { rank: "desc" },
            select: { rank: true },
        }),
        tx.playlistPendingTrack.findFirst({
            where: { playlistId },
            orderBy: { rank: "desc" },
            select: { rank: true },
        }),
    ]);
    const a = item?.rank ?? "";
    const b = pending?.rank ?? "";
    return a > b ? a : b;
}

/**
 * Smallest rank strictly greater than `after`, across BOTH tables.
 * Same reasoning as maxRank: a move must not land on a pending track's rank.
 */
async function nextRankAfter(
    tx: Pick<typeof prisma, "playlistItem" | "playlistPendingTrack">,
    playlistId: string,
    after: string,
    excludeItemId?: string
): Promise<string> {
    const [item, pending] = await Promise.all([
        tx.playlistItem.findFirst({
            where: {
                playlistId,
                rank: { gt: after },
                ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
            },
            orderBy: { rank: "asc" },
            select: { rank: true },
        }),
        tx.playlistPendingTrack.findFirst({
            where: { playlistId, rank: { gt: after } },
            orderBy: { rank: "asc" },
            select: { rank: true },
        }),
    ]);
    const a = item?.rank ?? "";
    const b = pending?.rank ?? "";
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
}

/**
 * `count` ranks that append to a playlist, the only way to allocate them. Spans
 * items and pending tracks, and chains from the true last rank so the new keys
 * keep the list's existing width ("000" < "C").
 */
export async function allocateAppendRanks(
    tx: Pick<typeof prisma, "playlistItem" | "playlistPendingTrack">,
    playlistId: string,
    count: number
): Promise<string[]> {
    if (count <= 0) return [];

    const last = await maxRank(tx, playlistId);

    // An empty playlist gets a spread block so the keys stay short.
    if (!last) return rankSequence(count);

    const ranks: string[] = [];
    let prev = last;
    for (let i = 0; i < count; i += 1) {
        prev = rankAfter(prev);
        ranks.push(prev);
    }
    return ranks;
}

/**
 * Marks each playlist entry `unavailable` when its song is not playable (Discover, missing or corrupt). A playlist
 * keeps listing such a song, so this only says which ones to grey out and skip in playback.
 */
export async function markUnavailable<T extends { trackId: string }>(
    items: T[]
): Promise<Array<T & { unavailable: boolean }>> {
    const ids = [...new Set(items.map((item) => item.trackId))];
    const playable = ids.length === 0
        ? []
        : await prisma.track.findMany({ where: { id: { in: ids }, ...PLAYABLE_SONG }, select: { id: true } });
    const playableIds = new Set(playable.map((t) => t.id));
    return items.map((item) => ({ ...item, unavailable: !playableIds.has(item.trackId) }));
}

/**
 * Append tracks in the given order. A playlist can hold a song more than once (an import or a Subsonic client puts
 * one there), but adding is by song: one the playlist already holds is reported as a duplicate, not added again and
 * not an error; ids that are not playable songs are rejected.
 */
export async function addTracks(
    playlistId: string,
    trackIds: string[]
): Promise<AddTracksResult> {
    const requested = [...new Set(trackIds)].filter(Boolean);
    if (requested.length === 0) {
        return { added: 0, duplicates: 0, rejected: [] };
    }
    if (requested.length > MAX_BULK_TRACKS) {
        throw new Error(
            `Cannot add more than ${MAX_BULK_TRACKS} tracks in one request`
        );
    }

    const playable = await prisma.track.findMany({
        where: { id: { in: requested }, ...PLAYABLE_SONG },
        select: { id: true },
    });
    const playableIds = new Set(playable.map((t) => t.id));
    const rejected = requested.filter((id) => !playableIds.has(id));

    // Preserve the caller's order among the tracks we will actually add.
    const toAdd = requested.filter((id) => playableIds.has(id));
    if (toAdd.length === 0) {
        return { added: 0, duplicates: 0, rejected };
    }

    return prisma.$transaction(async (tx) => {
        await lockPlaylist(tx, playlistId);

        const existing = await tx.playlistItem.findMany({
            where: { playlistId, trackId: { in: toAdd } },
            select: { trackId: true },
        });
        const alreadyThere = new Set(existing.map((e) => e.trackId));
        const fresh = toAdd.filter((id) => !alreadyThere.has(id));

        if (fresh.length === 0) {
            return { added: 0, duplicates: alreadyThere.size, rejected };
        }

        const ranks = await allocateAppendRanks(tx, playlistId, fresh.length);

        // rank orders the items; sort is kept monotonic for readers that still use it.
        const maxSort = await tx.playlistItem.aggregate({
            where: { playlistId },
            _max: { sort: true },
        });
        const firstSort = (maxSort._max.sort ?? -1) + 1;

        await tx.playlistItem.createMany({
            data: fresh.map((trackId, i) => ({
                playlistId,
                trackId,
                rank: ranks[i],
                sort: firstSort + i,
            })),
            skipDuplicates: true,
        });

        await tx.playlist.update({
            where: { id: playlistId },
            data: { updatedAt: new Date() },
        });

        return {
            added: fresh.length,
            duplicates: alreadyThere.size,
            rejected,
        };
    });
}

/**
 * Remove one entry of a playlist, or every entry of a song. `ref` is an item id (one copy of a repeated song goes) or,
 * for a client that names the song, a song id (all its copies go). An item id wins: ids of the two kinds never
 * collide. Returns how many entries were removed, so removing something already gone is not an error.
 */
export async function removeEntry(playlistId: string, ref: string): Promise<number> {
    if (!ref) return 0;
    const item = await prisma.playlistItem.findFirst({ where: { id: ref, playlistId }, select: { id: true } });
    const { count } = await prisma.playlistItem.deleteMany({
        where: item ? { id: item.id } : { playlistId, trackId: ref },
    });

    if (count > 0) {
        // The removal is committed: a failed timestamp touch is logged, not raised.
        try {
            await prisma.playlist.update({
                where: { id: playlistId },
                data: { updatedAt: new Date() },
            });
        } catch (error) {
            logger.warn(
                `[playlistService] removeEntry: could not touch updatedAt for ${playlistId}`,
                error
            );
        }
    }
    return count;
}

/**
 * Move one item so it sits directly after `afterItemId` (or first when null).
 * Only that row changes.
 */
export async function moveItem(
    playlistId: string,
    itemId: string,
    afterItemId: string | null
): Promise<{ rank: string }> {
    return prisma.$transaction(async (tx) => {
        await lockPlaylist(tx, playlistId);

        const item = await tx.playlistItem.findFirst({
            where: { id: itemId, playlistId },
            select: { id: true },
        });
        if (!item) {
            throw Object.assign(new Error("Item not in playlist"), {
                code: "ITEM_NOT_FOUND",
            });
        }

        let before = "";
        if (afterItemId) {
            const anchor = await tx.playlistItem.findFirst({
                where: { id: afterItemId, playlistId },
                select: { rank: true },
            });
            if (!anchor) {
                throw Object.assign(new Error("Anchor item not in playlist"), {
                    code: "ANCHOR_NOT_FOUND",
                });
            }
            before = anchor.rank;
        }

        const next = await nextRankAfter(tx, playlistId, before, itemId);

        // No item after the anchor: the move is to the end, so rank directly after it.
        const rank = next ? rankBetween(before, next) : rankAfter(before);
        await tx.playlistItem.update({ where: { id: itemId }, data: { rank } });
        await tx.playlist.update({
            where: { id: playlistId },
            data: { updatedAt: new Date() },
        });

        logger.debug(
            `[Playlist] Moved item ${itemId} to rank ${rank} in ${playlistId}`
        );
        return { rank };
    });
}
