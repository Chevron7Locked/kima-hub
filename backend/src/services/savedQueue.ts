/**
 * The saved queue: the list of songs a person's player left behind, kept on their playback state so any device can
 * pick it up. This is the one place that knows what an entry holds and which entries a client may be shown.
 *
 * - An entry carries what a player needs to draw it (title, artist, album, cover), so a device lists the queue
 *   without asking for every song.
 * - A client is shown only the playable songs of the stored queue (a song whose file went missing, or a Discover
 *   song, is left out). The stored queue itself is left as it is, so a song whose file comes back returns to it.
 *   When the current song is left out, the next playable one becomes current (else the last one before it), from its
 *   start.
 * - The index kept with the queue and the entries stay in one coordinate system: the stored one. A client counts what it
 *   was shown, so a save carries the index into the stored queue (`acceptQueue` for a queue sent whole,
 *   `indexIntoStoredQueue` for one that sends no queue and names the current song), and no index is stored past the
 *   stored queue's last entry.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { PLAYABLE_SONG } from "../utils/playableSong";

export type QueueEntry = {
    id: string;
    title?: string;
    /** The title as edited in Kima; the web player reads it too. */
    displayTitle?: string | null;
    duration?: number;
    artist?: { id?: string; name?: string } | null;
    album?: { id?: string; title?: string; coverArt?: string | null } | null;
};

/** The entries of a stored queue; anything in it that is not an entry with an id is left out. */
export function entriesOf(queue: unknown): QueueEntry[] {
    if (!Array.isArray(queue)) return [];
    return queue
        .map((item) => (item && typeof item === "object" ? (item as QueueEntry) : null))
        .filter((item): item is QueueEntry => Boolean(item?.id));
}

/**
 * Song ids as the full entries a player stores and renders, in the given order; ids Kima does not know are left out.
 * It describes the song as it is now: its edited title, its artist's display name, its album's chosen cover.
 */
export async function hydrateQueue(ids: string[], db: Pick<Prisma.TransactionClient, "track"> = prisma): Promise<QueueEntry[]> {
    if (ids.length === 0) return [];

    const tracks = await db.track.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            title: true,
            displayTitle: true,
            duration: true,
            album: {
                select: {
                    id: true,
                    title: true,
                    coverUrl: true,
                    userCoverUrl: true,
                    artist: { select: { id: true, name: true, displayName: true } },
                },
            },
        },
    });

    const byId = new Map(tracks.map((t) => [t.id, t]));
    return ids
        .map((id) => byId.get(id))
        .filter((t): t is NonNullable<typeof t> => t != null)
        .map((t) => ({
            id: t.id,
            title: t.title,
            displayTitle: t.displayTitle,
            duration: t.duration ?? undefined,
            artist: t.album?.artist
                ? {
                      id: t.album.artist.id,
                      name: t.album.artist.displayName || t.album.artist.name,
                  }
                : null,
            album: t.album
                ? {
                      id: t.album.id,
                      title: t.album.title,
                      coverArt: t.album.userCoverUrl || t.album.coverUrl,
                  }
                : null,
        }));
}

/** A whole, non-negative index from whatever a client sent. */
function wholeIndex(raw: unknown): number {
    return Math.max(0, Math.floor(Number(raw) || 0));
}

const clip = (value: unknown, max: number, fallback: string) => String(value || fallback).substring(0, max);

/**
 * A queue as a client sends it, made into what is stored: entries without an id are dropped, then the queue is cut to
 * `limit`, and the index (counted over the entries as sent) is carried over to where its song now sits. An index whose
 * own entry was dropped points at the next entry kept; one past the end points at the last. No entries at all stores
 * no queue and index 0.
 */
export function acceptQueue(raw: readonly unknown[], rawIndex: unknown, limit: number): { queue: QueueEntry[] | null; currentIndex: number } {
    const index = wholeIndex(rawIndex);
    const withId = (item: unknown): item is Record<string, any> => Boolean(item && typeof item === "object" && (item as { id?: unknown }).id);
    const droppedBefore = raw.slice(0, index).filter((item) => !withId(item)).length;
    const queue = raw
        .filter(withId)
        .slice(0, limit)
        .map((item): QueueEntry => ({
            id: String(item.id),
            title: clip(item.title, 500, "Unknown"),
            // The title as edited in Kima, so every device shows the edit.
            displayTitle: item.displayTitle ? String(item.displayTitle).substring(0, 500) : null,
            duration: Number(item.duration) || 0,
            artist: item.artist ? { id: String(item.artist.id || ""), name: clip(item.artist.name, 200, "Unknown") } : null,
            album: item.album
                ? {
                      id: String(item.album.id || ""),
                      title: clip(item.album.title, 500, "Unknown"),
                      coverArt: item.album.coverArt ? String(item.album.coverArt).substring(0, 1000) : null,
                  }
                : null,
        }));
    if (queue.length === 0) return { queue: null, currentIndex: 0 };
    return { queue, currentIndex: Math.min(Math.max(index - droppedBefore, 0), queue.length - 1) };
}

/**
 * Where in the stored queue a save that sends no queue puts the current song. The client counts what it was shown,
 * which leaves out the songs that are not playable, so its index is mapped onto the stored queue. When it names the
 * song, the song decides: the stored index that holds it (the client's own count, shown or stored, when that is
 * where the song is, else the nearest place it sits). A song the stored queue does not hold, or none named, leaves the
 * mapped index.
 */
export function pointIntoStored(stored: readonly QueueEntry[], clientIndex: unknown, trackId: unknown, playable: ReadonlySet<string>): number {
    if (stored.length === 0) return 0;
    const asked = wholeIndex(clientIndex);
    const shownAt = stored.flatMap((item, i) => (playable.has(item.id) ? [i] : []));
    const counted = Math.min(asked, stored.length - 1);
    const mapped = shownAt.length === 0 ? counted : shownAt[Math.min(asked, shownAt.length - 1)];
    if (!namesSong(trackId)) return mapped;
    for (const at of [mapped, counted]) if (stored[at].id === trackId) return at;
    return placeNearest(stored, trackId, mapped) ?? mapped;
}

/** Where the stored queue holds the song, the place nearest `to` when it sits more than once; null when it does not. */
function placeNearest(stored: readonly QueueEntry[], id: unknown, to: number): number | null {
    const holding = stored.flatMap((item, i) => (item.id === id ? [i] : []));
    if (holding.length === 0) return null;
    return holding.reduce((best, i) => (Math.abs(i - to) < Math.abs(best - to) ? i : best));
}

const namesSong = (trackId: unknown): trackId is string => typeof trackId === "string" && trackId !== "";

/** Whether a save that sends no queue says where the player is: an index, or the song it is on. */
export function namesCurrentSong(clientIndex: unknown, trackId: unknown): boolean {
    return typeof clientIndex === "number" || namesSong(trackId);
}

/**
 * The index to store for a save that sends no queue, worked out against the queue as it stands. The state row is
 * locked first, so a queue being written at the same moment finishes first and the index points into that queue, and
 * the caller's write, in the same transaction, lands before any other.
 *
 * With an index, a person with no stored queue gets 0. A save that names the song but sends no index finds it in the
 * stored queue (the place nearest the stored index, when it sits twice); a song the stored queue does not hold (an
 * empty queue holds none) leaves the stored index as it is, which is `null` here, and a first save then creates 0.
 */
export async function indexIntoStoredQueue(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "playbackState" | "track">,
    userId: string,
    clientIndex: unknown,
    trackId: unknown,
): Promise<number | null> {
    await tx.$queryRaw`SELECT "userId" FROM "PlaybackState" WHERE "userId" = ${userId} FOR UPDATE`;
    const state = await tx.playbackState.findUnique({ where: { userId }, select: { queue: true, currentIndex: true } });
    const stored = entriesOf(state?.queue);
    if (typeof clientIndex !== "number") return placeNearest(stored, trackId, state?.currentIndex ?? 0);
    if (stored.length === 0) return 0;
    const playable = new Set(
        (await tx.track.findMany({ where: { id: { in: stored.map((item) => item.id) }, ...PLAYABLE_SONG }, select: { id: true } })).map((t) => t.id),
    );
    return pointIntoStored(stored, clientIndex, trackId, playable);
}

/** The saved queue as a client is shown it. */
export interface PlayableQueue {
    queue: QueueEntry[];
    currentIndex: number;
    position: number;
    /** The track the state names, or the song now current when that one is not playable. */
    trackId: string | null;
}

export async function playableQueue(
    state: { queue: unknown; currentIndex: number; position: number; trackId?: string | null } | null,
): Promise<PlayableQueue> {
    const saved = entriesOf(state?.queue);
    const named = state?.trackId ?? null;
    const asked = [...saved.map((item) => item.id), ...(named !== null ? [named] : [])];
    const playable = new Set(
        asked.length === 0
            ? []
            : (
                  await prisma.track.findMany({
                      where: { id: { in: asked }, ...PLAYABLE_SONG },
                      select: { id: true },
                  })
              ).map((t) => t.id),
    );
    const savedIndex = Math.min(Math.max(state?.currentIndex ?? 0, 0), Math.max(saved.length - 1, 0));
    const shownBefore = saved.slice(0, savedIndex).filter((item) => playable.has(item.id)).length;
    const queue = saved.filter((item) => playable.has(item.id));
    const currentKept = saved.length > 0 && playable.has(saved[savedIndex].id);
    const currentIndex = queue.length === 0 ? 0 : Math.min(shownBefore, queue.length - 1);
    // A song the state names that is not playable (gone, or on a Discover album) is never handed back: the song now
    // current stands in for it, and there is none when the queue shows nothing.
    const trackId = named === null || playable.has(named) ? named : (queue[currentIndex]?.id ?? null);
    return {
        queue,
        currentIndex,
        position: currentKept ? (state?.position ?? 0) : 0,
        trackId,
    };
}
