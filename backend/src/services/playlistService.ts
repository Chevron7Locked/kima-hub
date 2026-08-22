/**
 * Playlist mutations.
 *
 * Every write in here is transactional and bulk-shaped. The route handlers used
 * to do it inline, one track at a time:
 *
 *   - Adding a track was four sequential round trips with no transaction, so two
 *     concurrent adds both read the same max(sort) and wrote the same position.
 *   - There was no bulk endpoint at all, so "add this album to a playlist" was N
 *     HTTP requests from the browser at four queries each -- 48 queries for a
 *     12-track album.
 *   - Reordering issued one UPDATE per row inside a single transaction, holding
 *     locks across the whole playlist, and renumbered every position.
 *
 * Ordering uses fractional ranks (see utils/lexoRank), so a move writes exactly
 * one row and positions cannot collide.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { rankAfter, rankBetween, rankSequence } from "../utils/lexoRank";

/** Cap on a single bulk operation, so one request cannot pin a connection. */
export const MAX_BULK_TRACKS = 1000;

export interface AddTracksResult {
    added: number;
    /** Already present in the playlist; not an error. */
    duplicates: number;
    /** Requested but not a streamable library track. */
    rejected: string[];
}

/**
 * Serialise mutations for one playlist.
 *
 * Read-then-write on max(rank) is only safe if concurrent writers are ordered.
 * A Postgres advisory lock keyed on the playlist does that without a table lock,
 * and is released automatically at commit.
 */
async function lockPlaylist(
    tx: Pick<typeof prisma, "$executeRaw">,
    playlistId: string
): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${playlistId}))`;
}

/**
 * Highest rank in the playlist across BOTH tables.
 *
 * Items and pending tracks share one key space, so a max taken from items alone
 * will happily collide with a pending track's rank -- and the unique index is
 * per-table, so the database cannot catch that. Every rank allocation has to
 * consider both.
 */
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
 * Append tracks to a playlist, in the order given.
 *
 * Tracks that are already present are reported as duplicates rather than
 * failing the request -- adding an album that partially overlaps the playlist is
 * a normal thing to do. Tracks that are not streamable library tracks are
 * rejected: a DISCOVER-location track has no file and would 404 on play, and
 * nothing stopped that before.
 */
/**
 * `count` ranks that append to the end of a playlist, in order.
 *
 * The ONLY way to allocate an appending rank. It spans BOTH tables, because
 * items and pending tracks share one ordering space and no per-table index can
 * see across them.
 *
 * It also has to chain from the existing last rank rather than derive keys from
 * a position. `rankForPosition` emits fixed 3-character keys while
 * `rankSequence` emits 1-character ones, and "000" < "C" -- so a position-derived
 * append into a natively-seeded playlist landed the whole batch AHEAD of
 * everything already there. Chaining preserves whatever width the list already
 * uses and always lands after the true last entry.
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
        where: { id: { in: requested } },
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

        // `sort` is legacy -- rank is authoritative -- but it must stay
        // monotonic while anything still reads it. Writing `sort: i` restarted
        // at 0 on every call, so max(sort) no longer described the end of the
        // list and any consumer deriving a position from it got a stale one.
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
 * Remove tracks from a playlist.
 *
 * Returns the number actually removed so the caller can distinguish "nothing
 * matched" from "removed". The old single-track handler called `delete`, which
 * throws P2025 when the row is gone, and the generic catch turned that into a
 * 500 -- so double-clicking remove surfaced a server error.
 */
export async function removeTracks(
    playlistId: string,
    trackIds: string[]
): Promise<number> {
    const ids = [...new Set(trackIds)].filter(Boolean);
    if (ids.length === 0) return 0;

    const { count } = await prisma.playlistItem.deleteMany({
        where: { playlistId, trackId: { in: ids } },
    });

    if (count > 0) {
        // The removal already committed, so a failure here is not worth failing
        // the request over -- but swallowing it silently meant a playlist could
        // stop advertising changes with nothing to point at. Log it.
        try {
            await prisma.playlist.update({
                where: { id: playlistId },
                data: { updatedAt: new Date() },
            });
        } catch (error) {
            logger.warn(
                `[playlistService] removeTracks: could not touch updatedAt for ${playlistId}`,
                error
            );
        }
    }
    return count;
}

/**
 * Move one item so it sits directly after `afterItemId` (or first when null).
 *
 * One row changes. The previous reorder endpoint rewrote every row in the
 * playlist and required the client to send the complete ordering, so a partial
 * list silently reshuffled the rest.
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

        // When nextRankAfter returns empty (no item after the anchor), the moved
        // item is being placed at the end of the playlist. rankAfter(before)
        // generates a key that sorts directly after the anchor — the correct
        // destination for a move-to-end. Using rankBetween(before, "") would
        // also work but rankAfter is the idiomatic call for this case.
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
