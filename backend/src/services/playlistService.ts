/**
 * Playlist mutations, each transactional and bulk-shaped. Ordering uses
 * fractional ranks (utils/lexoRank), so a move writes one row and positions
 * cannot collide.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { rankAfter, rankBetween, rankForPosition, rankSequence, ranksBetween } from "../utils/lexoRank";
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

/** The next `sort` value: rank orders the items, and sort is kept monotonic for readers that still use it. */
async function nextSort(tx: Pick<typeof prisma, "playlistItem">, playlistId: string): Promise<number> {
    const { _max } = await tx.playlistItem.aggregate({ where: { playlistId }, _max: { sort: true } });
    return (_max.sort ?? -1) + 1;
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

        const firstSort = await nextSort(tx, playlistId);

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

/** A song the library has found. `pendingId` is the waiting entry it answers, when there is one. */
export interface FoundSong {
    trackId: string;
    pendingId?: string;
}

/**
 * Put songs a library scan or refresh has found into a playlist. Items and waiting entries share one rank space, so a
 * song that answers a waiting entry takes that entry's rank and lands exactly where the page showed it, between the
 * same neighbours, whatever a person has moved since. A song with no waiting entry is appended. Moving the entry into
 * the items is one transaction under the playlist lock: a waiting entry another writer already answered is skipped,
 * so two scans finding the same song add it once. Returns the songs it placed.
 */
export async function placeFoundSongs(playlistId: string, found: FoundSong[]): Promise<FoundSong[]> {
    if (found.length === 0) return [];
    return prisma.$transaction(async (tx) => {
        await lockPlaylist(tx, playlistId);

        const waitingIds = found.flatMap((f) => (f.pendingId ? [f.pendingId] : []));
        const waiting = new Map(
            (await tx.playlistPendingTrack.findMany({ where: { id: { in: waitingIds }, playlistId } })).map((w) => [w.id, w])
        );
        const taken = new Set(
            (await tx.playlistItem.findMany({
                where: { playlistId, rank: { in: [...waiting.values()].map((w) => w.rank) } },
                select: { rank: true },
            })).map((i) => i.rank)
        );

        const placed: FoundSong[] = [];
        const inPlace: { trackId: string; rank: string }[] = [];
        const toAppend: string[] = [];
        for (const song of found) {
            if (!song.pendingId) {
                toAppend.push(song.trackId);
                placed.push(song);
                continue;
            }
            const entry = waiting.get(song.pendingId);
            if (!entry) continue;
            waiting.delete(song.pendingId);
            placed.push(song);
            // A blank or taken rank cannot hold the song's place; it goes to the end rather than break uniqueness.
            if (!entry.rank || taken.has(entry.rank)) toAppend.push(song.trackId);
            else inPlace.push({ trackId: song.trackId, rank: entry.rank });
        }

        // Allocated while the answered entries still hold their ranks, so an appended song cannot land on one.
        const appendRanks = await allocateAppendRanks(tx, playlistId, toAppend.length);
        const answered = placed.flatMap((s) => (s.pendingId ? [s.pendingId] : []));
        if (answered.length > 0) await tx.playlistPendingTrack.deleteMany({ where: { id: { in: answered } } });

        const rows = [...inPlace, ...toAppend.map((trackId, i) => ({ trackId, rank: appendRanks[i] }))];
        if (rows.length === 0) return placed;

        const firstSort = await nextSort(tx, playlistId);
        await tx.playlistItem.createMany({
            data: rows.map((row, i) => ({ playlistId, trackId: row.trackId, rank: row.rank, sort: firstSort + i })),
        });
        await tx.playlist.update({ where: { id: playlistId }, data: { updatedAt: new Date() } });
        return placed;
    });
}

/**
 * Replace every item of a playlist with the songs `shown`, in that order, then the songs `hidden` (kept but never
 * shown to the caller), inside the caller's transaction (which holds the playlist lock). Waiting entries are not the
 * caller's to see or move: each keeps its rank, and the new items are ranked around them. A waiting entry stays after
 * the shown song that came before it in the old order, at that song's first place in the new list; when that song is
 * gone, after the nearest earlier old song that is still shown, or first when none is. A hidden song is never an anchor:
 * it moves to the end, and an entry that followed it stays with the shown song before it. Waiting entries keep their
 * order among themselves, so one never passes the one that was ahead of it. Returns whether anything was removed or
 * written.
 */
export async function replaceItems(
    tx: Pick<typeof prisma, "playlistItem" | "playlistPendingTrack">,
    playlistId: string,
    shown: string[],
    hidden: string[] = []
): Promise<boolean> {
    const trackIds = [...shown, ...hidden];
    const [oldItems, waiting] = await Promise.all([
        tx.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" }, select: { trackId: true, rank: true } }),
        tx.playlistPendingTrack.findMany({
            where: { playlistId, rank: { not: "" } },
            orderBy: { rank: "asc" },
            select: { rank: true },
        }),
    ]);

    const firstPlace = new Map<string, number>();
    shown.forEach((trackId, index) => {
        if (!firstPlace.has(trackId)) firstPlace.set(trackId, index);
    });

    // For each waiting entry (in rank order), the new position it follows: -1 for the start.
    const follows: number[] = [];
    let behind = -1;
    let oldIndex = 0;
    let latest = -1;
    for (const entry of waiting) {
        // The old items that sorted before this entry; the last of them that is still listed is its anchor.
        while (oldIndex < oldItems.length && oldItems[oldIndex].rank < entry.rank) {
            const place = firstPlace.get(oldItems[oldIndex].trackId);
            if (place !== undefined) behind = place;
            oldIndex += 1;
        }
        latest = Math.max(latest, behind);
        follows.push(latest);
    }

    // Item positions after waiting entry j (and before j + 1) take ranks inside that gap.
    // With none waiting the ranks are the plain fixed-width ones.
    const ranks: string[] = [];
    if (waiting.length === 0) {
        trackIds.forEach((_, index) => ranks.push(rankForPosition(index)));
    } else {
        for (let gap = 0; gap <= waiting.length; gap += 1) {
            const upTo = gap < waiting.length ? follows[gap] : trackIds.length - 1;
            const count = upTo - ranks.length + 1;
            const lower = gap === 0 ? "" : waiting[gap - 1].rank;
            const upper = gap < waiting.length ? waiting[gap].rank : "";
            ranks.push(...ranksBetween(lower, upper, count));
        }
    }

    const removed = await tx.playlistItem.deleteMany({ where: { playlistId } });
    const created = await tx.playlistItem.createMany({
        data: trackIds.map((trackId, index) => ({ playlistId, trackId, sort: index, rank: ranks[index] })),
    });
    return removed.count > 0 || created.count > 0;
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
