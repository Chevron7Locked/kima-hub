/**
 * The saved queue: the list of songs a person's player left behind, kept on their playback state so any device can
 * pick it up. This is the one place that knows what an entry holds and which entries a client may be shown.
 *
 * - An entry carries what a player needs to draw it (title, artist, album, cover), so a device lists the queue
 *   without asking for every song. Kima is the source of truth for those details: a save, web or Subsonic, sends song
 *   ids (a web save sends entries, of which only the id is read), and the entry stored is Kima's own description of the
 *   song. An id Kima does not know is left out.
 * - A Discover song is never stored in a queue ("Discover is only Discover"): a save leaves it out like an unknown id.
 *   A song whose file went missing, or that was read as corrupt, is stored (it may come back) and hidden on read.
 * - A client is shown each song as it is now (an edited title, a renamed artist, a new cover), not as the entry was
 *   saved; the stored entries stay as saved.
 * - A client is shown only the playable songs of the stored queue (a song whose file went missing, or a Discover
 *   song, is left out). The stored queue itself is left as it is, so a song whose file comes back returns to it.
 *   When the current song is left out, the next playable one becomes current (else the last one before it), from its
 *   start.
 * - The index kept with the queue and the entries stay in one coordinate system: the stored one. A client counts what it
 *   was shown, so a save carries the index into the stored queue (`planQueue` for a queue sent as ids, whole or as
 *   entries, `indexIntoStoredQueue` for one that sends no queue and names the current song), and no index is stored
 *   past the stored queue's last entry.
 * - Every save takes the person's turn (`lockPlaybackState`) in the transaction that writes: an advisory lock on the
 *   person, then their state row, which is what the library sweep waits on when it rewrites a queue that holds a song it
 *   retires. A save that sends song ids reads songs, and the sweep waits on no row of a person whose queue lacks the
 *   song it retires (or who has no row yet), so that save first holds the songs it reads until it commits
 *   (`lockForQueueSave`). The order is the sweep's: songs, then the state row.
 * - A save reads the queue limit (`queueLimit`) before it opens its transaction, never inside it: the read may take its
 *   own connection from the pool, and a save must not hold one connection while it waits for a second.
 */
import { prisma, Prisma } from "../utils/db";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { getSystemSettings, QUEUE_LENGTH } from "../utils/systemSettings";
import { logger } from "../utils/logger";

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

/** What a song is read for when an entry is made of it: the one select, so a saved entry and a shown one agree. */
const DESCRIBED = {
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
} satisfies Prisma.TrackSelect;

function describeSong(t: Prisma.TrackGetPayload<{ select: typeof DESCRIBED }>): QueueEntry {
    return {
        id: t.id,
        title: t.title,
        displayTitle: t.displayTitle,
        duration: t.duration ?? undefined,
        artist: t.album?.artist ? { id: t.album.artist.id, name: t.album.artist.displayName || t.album.artist.name } : null,
        album: t.album ? { id: t.album.id, title: t.album.title, coverArt: t.album.userCoverUrl || t.album.coverUrl } : null,
    };
}

/**
 * Song ids as the full entries a player stores and renders, in the given order; ids Kima does not know are left out.
 * It describes the song as it is now: its edited title, its artist's display name, its album's chosen cover. `only`
 * narrows which songs count as known.
 */
export async function hydrateQueue(
    ids: string[],
    db: Pick<Prisma.TransactionClient, "track"> = prisma,
    only: Prisma.TrackWhereInput = {},
): Promise<QueueEntry[]> {
    if (ids.length === 0) return [];

    const tracks = await db.track.findMany({ where: { id: { in: ids }, ...only }, select: DESCRIBED });
    const byId = new Map(tracks.map((t) => [t.id, describeSong(t)]));
    return ids.map((id) => byId.get(id)).filter((entry): entry is QueueEntry => entry != null);
}

/**
 * The operator's queue length limit, clamped on read in case the stored value was edited by hand. Read through the
 * system settings (a save of them drops the cache, so a saved limit applies at once). Every save cuts to it, web or
 * Subsonic. A read that fails must not stop somebody's queue saving: it falls back to the default and says so.
 */
export async function queueLimit(): Promise<number> {
    let value: number = QUEUE_LENGTH.default;
    try {
        const settings = await getSystemSettings();
        if (settings?.maxQueueLength) value = settings.maxQueueLength;
    } catch (error) {
        logger.warn("[SavedQueue] Could not read the queue length limit, using the default:", error);
    }
    return Math.min(QUEUE_LENGTH.max, Math.max(QUEUE_LENGTH.min, Math.floor(value)));
}

/** A whole, non-negative index from whatever a client sent. */
function wholeIndex(raw: unknown): number {
    return Math.max(0, Math.floor(Number(raw) || 0));
}

/**
 * The song ids of a queue a web client sends as entries, in order, and the place it is on counted over those ids. Only
 * an entry's id is read: the song's details are Kima's own (`planQueue`). Entries without an id are dropped, and the
 * index (counted over the entries as sent) moves back by the ones dropped before it, so an index whose own entry was
 * dropped points at the next entry kept.
 */
export function queueIdsOf(raw: readonly unknown[], rawIndex: unknown): { ids: string[]; clientIndex: number } {
    const index = wholeIndex(rawIndex);
    const idOf = (item: unknown): string | null => {
        const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
        return id ? String(id) : null;
    };
    const droppedBefore = raw.slice(0, index).filter((item) => idOf(item) === null).length;
    return { ids: raw.flatMap((item) => idOf(item) ?? []), clientIndex: index - droppedBefore };
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
 * Takes the person's turn to save, then their state row, until the transaction ends. The turn is a lock on the person
 * (a first save has no row yet, and two saves of one person never meet); the row is what the library sweep rewriting a
 * queue waits on. The one lock every save takes, web or Subsonic.
 */
export async function lockPlaybackState(tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`playback-state:${userId}`}, 0))`;
    await tx.$queryRaw`SELECT "userId" FROM "PlaybackState" WHERE "userId" = ${userId} FOR UPDATE`;
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
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw" | "playbackState" | "track">,
    userId: string,
    clientIndex: unknown,
    trackId: unknown,
): Promise<number | null> {
    await lockPlaybackState(tx, userId);
    const state = await tx.playbackState.findUnique({ where: { userId }, select: { queue: true, currentIndex: true } });
    const stored = entriesOf(state?.queue);
    if (typeof clientIndex !== "number") return placeNearest(stored, trackId, state?.currentIndex ?? 0);
    if (stored.length === 0) return 0;
    const playable = new Set(
        (await tx.track.findMany({ where: { id: { in: stored.map((item) => item.id) }, ...PLAYABLE_SONG }, select: { id: true } })).map((t) => t.id),
    );
    return pointIntoStored(stored, clientIndex, trackId, playable);
}

/** A playback state row as stored. */
export type PlaybackStateRow = Prisma.PlaybackStateGetPayload<object>;

/**
 * Where the client's current place sits in the queue as stored, which leaves out the ids Kima did not know. The places
 * before it that were dropped no longer count, so the stored index still names the client's current place, counted by
 * place and not by song (a song listed twice is two places). `queueLength` is how many entries the stored queue has.
 * `placeKept` is whether that place itself is in the stored queue: its id is known and it was not cut; when it is not,
 * the stored index is the place now standing in for it.
 */
function storedPlaceOf(
    ids: readonly string[],
    known: ReadonlySet<string>,
    queueLength: number,
    clientIndex: number,
): { index: number; placeKept: boolean } {
    if (queueLength === 0) return { index: 0, placeKept: false };
    const before = ids.slice(0, clientIndex).filter((id) => known.has(id)).length;
    return { index: Math.min(before, queueLength - 1), placeKept: known.has(ids[clientIndex]) && before < queueLength };
}

/**
 * Holds the rows of the songs a save is about to read until the transaction ends, so the sweep (which holds the rows
 * of the songs it retires, and takes the ones another transaction holds only on its next run) and the save go one at a
 * time: a song retired first is not read, and one read first is not retired. A key lock, which only a retiring or
 * deleting transaction conflicts with, so ordinary edits to the songs go on.
 */
async function holdSongs(tx: Pick<Prisma.TransactionClient, "$queryRaw">, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.$queryRaw`SELECT id FROM "Track" WHERE id = ANY(${[...new Set(ids)]}::text[]) ORDER BY id FOR KEY SHARE`;
}

/**
 * What a save that sends song ids takes before it reads them: the songs (`holdSongs`), then the person's turn and state
 * row (`lockPlaybackState`), the order the sweep takes them in, so the two never wait on each other. Held until the
 * transaction ends. A save that sends no ids takes `lockPlaybackState` alone.
 */
export async function lockForQueueSave(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
    userId: string,
    ids: readonly string[],
): Promise<void> {
    await holdSongs(tx, ids);
    await lockPlaybackState(tx, userId);
}

/** The part of the playable-song rule a stored queue holds songs to: a library album's song. */
const STORABLE_SONG = { album: PLAYABLE_SONG.album } satisfies Prisma.TrackWhereInput;

/**
 * A queue sent as song ids, made into what is stored, read under the locks `lockForQueueSave` took: the entries are
 * Kima's own description of each song. Ids Kima does not know, and songs on a Discover album, are left out; a song whose
 * file is missing or corrupt is kept (it is hidden when the queue is read). The queue is cut to `limit` after those are
 * left out, and `clientIndex` (counting `ids`) is carried over to where its place now sits: the places before it that
 * were left out no longer count, and an index whose own place was left out or cut points at the place standing in for
 * it, the last one at most. `placeKept` is whether the place itself is in the stored queue. No song kept stores no
 * queue, index 0.
 */
export async function planQueue(
    tx: Pick<Prisma.TransactionClient, "track">,
    ids: string[],
    clientIndex: number,
    limit: number,
): Promise<{ queue: QueueEntry[] | null; currentIndex: number; placeKept: boolean }> {
    const known = await hydrateQueue(ids, tx, STORABLE_SONG);
    const queue = known.slice(0, limit);
    const place = storedPlaceOf(ids, new Set(known.map((item) => item.id)), queue.length, clientIndex);
    return { queue: queue.length > 0 ? queue : null, currentIndex: place.index, placeKept: place.placeKept };
}

const INT32_MAX = 2_147_483_647;
/** The wait for the row lock counts toward a transaction's time limit (5 s by default), and a long queue takes a while to read. */
export const SAVE_TIMEOUT_MS = 30_000;

/**
 * A queue a Subsonic app saves, as song ids and the place it is on (`clientIndex` counts `ids`). The songs and the
 * person's state row are locked first (`lockForQueueSave`: the sweep waits on the row only when the queue holds a song
 * it retires, and a first save has no row at all), then the songs are read, the index worked out and the queue written
 * in the same transaction, so a library sweep retiring a song at the same moment finishes first and the queue never
 * stores what it took out, and a web save meeting this one leaves one whole save. What is left out, and how the queue is
 * cut and the index carried over, is `planQueue`'s; when the current song is left out, the song now in its place is
 * current, from its start. The position is kept when the current place itself is kept, not when another place holds its
 * song. The queue limit is read before the transaction opens.
 */
export async function saveQueueOfIds(
    userId: string,
    save: { ids: string[]; clientIndex: number; position: number; changedBy: string },
): Promise<void> {
    const limit = await queueLimit();
    await prisma.$transaction(async (tx) => {
        await lockForQueueSave(tx, userId, save.ids);
        const plan = await planQueue(tx, save.ids, save.clientIndex, limit);
        const data = {
            playbackType: "track",
            trackId: plan.queue?.[plan.currentIndex]?.id ?? null,
            audiobookId: null,
            podcastId: null,
            queue: plan.queue ? (plan.queue as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            // A queue a Subsonic app saved did not come from a Kima page.
            queueSource: null,
            currentIndex: plan.currentIndex,
            isShuffle: false,
            // The column is a 32-bit integer; a larger number from a client is no position anyone reached.
            // The position is the current place's own: another place holding the same song does not carry it.
            position: plan.placeKept ? Math.min(save.position, INT32_MAX) : 0,
            changedBy: save.changedBy,
        };
        await tx.playbackState.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    }, { timeout: SAVE_TIMEOUT_MS });
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
    const now = new Map(
        asked.length === 0
            ? []
            : (await prisma.track.findMany({ where: { id: { in: asked }, ...PLAYABLE_SONG }, select: DESCRIBED })).map(
                  (t) => [t.id, describeSong(t)] as const,
              ),
    );
    const savedIndex = Math.min(Math.max(state?.currentIndex ?? 0, 0), Math.max(saved.length - 1, 0));
    const shownBefore = saved.slice(0, savedIndex).filter((item) => now.has(item.id)).length;
    // Each song is shown as it is now (an edited title, a renamed artist, a new cover), not as it was when saved.
    const queue = saved.flatMap((item) => now.get(item.id) ?? []);
    const currentKept = saved.length > 0 && now.has(saved[savedIndex].id);
    const currentIndex = queue.length === 0 ? 0 : Math.min(shownBefore, queue.length - 1);
    // A song the state names that is not playable (gone, or on a Discover album) is never handed back: the song now
    // current stands in for it, and there is none when the queue shows nothing.
    const trackId = named === null || now.has(named) ? named : (queue[currentIndex]?.id ?? null);
    return {
        queue,
        currentIndex,
        position: currentKept ? (state?.position ?? 0) : 0,
        trackId,
    };
}

/**
 * A playback state row as a client is shown it, whether it asked for it or has just saved it: only the queue's playable
 * songs, the index into those, and the song now current when the one named is not playable. What is stored stays as it
 * is. No row stays no row.
 */
export async function shownState(state: PlaybackStateRow | null) {
    if (!state) return state;
    const shown = await playableQueue(state);
    if (!Array.isArray(state.queue)) return { ...state, trackId: shown.trackId };
    return {
        ...state,
        queue: shown.queue.length > 0 ? shown.queue : null,
        queueSource: shown.queue.length > 0 ? state.queueSource : null,
        currentIndex: shown.currentIndex,
        position: shown.position,
        trackId: shown.trackId,
    };
}
