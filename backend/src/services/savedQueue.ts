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
 */
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
export async function hydrateQueue(ids: string[]): Promise<QueueEntry[]> {
    if (ids.length === 0) return [];

    const tracks = await prisma.track.findMany({
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

/** The saved queue as a client is shown it. */
export interface PlayableQueue {
    queue: QueueEntry[];
    currentIndex: number;
    position: number;
    /** The song the stored queue was on; it differs from the one now current when that song was left out. */
    storedCurrentId: string | null;
}

export async function playableQueue(
    state: { queue: unknown; currentIndex: number; position: number } | null,
): Promise<PlayableQueue> {
    const saved = entriesOf(state?.queue);
    const playable = new Set(
        saved.length === 0
            ? []
            : (
                  await prisma.track.findMany({
                      where: { id: { in: saved.map((item) => item.id) }, ...PLAYABLE_SONG },
                      select: { id: true },
                  })
              ).map((t) => t.id),
    );
    const savedIndex = Math.min(Math.max(state?.currentIndex ?? 0, 0), Math.max(saved.length - 1, 0));
    const shownBefore = saved.slice(0, savedIndex).filter((item) => playable.has(item.id)).length;
    const queue = saved.filter((item) => playable.has(item.id));
    const currentKept = saved.length > 0 && playable.has(saved[savedIndex].id);
    return {
        queue,
        currentIndex: queue.length === 0 ? 0 : Math.min(shownBefore, queue.length - 1),
        position: currentKept ? (state?.position ?? 0) : 0,
        storedCurrentId: saved[savedIndex]?.id ?? null,
    };
}
