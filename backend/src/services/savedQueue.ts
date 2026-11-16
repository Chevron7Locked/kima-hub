/**
 * The saved queue: the list of songs a person's player left behind, kept on their playback state so any device can
 * pick it up. This is the one place that knows what an entry holds and which entries a client may be shown.
 *
 * - An entry carries what a player needs to draw it (title, artist, album, cover), so a device lists the queue
 *   without asking for every song. Kima is the source of truth for those details: a save, web or Subsonic, sends song
 *   ids (a web save sends entries, of which only the id is read), and the entry stored is Kima's own description of the
 *   song. An id Kima does not know is left out.
 * - A Discover song is never stored in a queue ("Discover is only Discover"): a save leaves it out like an unknown id
 *   (`ON_LIBRARY_ALBUM`, which the library sweep also reads a replacing copy with).
 *   A song whose file went missing, or that was read as corrupt, is stored (it may come back) and hidden on read. A
 *   client sends back the queue it was shown, which lacks those songs, so a save that replaces the queue keeps the ones
 *   the stored queue holds, each beside the songs it sat between (`planQueue`).
 * - A client is shown each song as it is now (an edited title, a renamed artist, a new cover), not as the entry was
 *   saved; the stored entries stay as saved.
 * - A client is shown only the playable songs of the stored queue (a song whose file went missing, or a Discover
 *   song, is left out). The stored queue itself is left as it is, so a song whose file comes back returns to it.
 *   When the current song is left out, the next playable one becomes current (else the last one before it), and the
 *   position is the saved current song's own, so the song standing in for it starts from 0.
 * - The index kept with the queue and the entries stay in one coordinate system: the stored one. A client counts what it
 *   was shown, so a save carries the index into the stored queue (`planQueue` for a queue sent as ids, whole or as
 *   entries, `indexIntoStoredQueue` for one that sends no queue and names the current song), and no index is stored
 *   past the stored queue's last entry.
 * - Every save takes the person's turn (`lockPlaybackState`) in the transaction that writes: an advisory lock on the
 *   person, then their state row, which is what the library sweep waits on when it rewrites a queue that holds a song it
 *   retires. A save that sends song ids reads songs, and the sweep waits on no row of a person whose queue lacks the
 *   song it retires (or who has no row yet), so that save first holds the songs it stores until it commits
 *   (`lockForQueueSave`: only the ones that will be stored, so a song left out or cut is not waited for). The order is
 *   the sweep's: the person's turn, the songs, then the state row. A save that sends no queue but names the current song
 *   holds that one song (a limit of 1), and a podcast episode a save names is checked under the same turn
 *   (`namesEpisode`), so a song or episode that is gone is stored as none.
 * - A save reads the queue limit (`queueLimit`) before it opens its transaction, never inside it: the read may take its
 *   own connection from the pool, and a save must not hold one connection while it waits for a second.
 *
 * The interface is what a caller does with a person's playback state: read a web request into a save (`readWebSave`),
 * save it (`saveWebState`), read the state a client is shown (`readPlaybackState`), clear it (`clearPlaybackState`),
 * save a Subsonic app's queue (`saveQueueOfIds`) and read it for one (`playableQueue`). The locks, the plan and the
 * write are inside, in one order, so no caller knows it. `entriesOf`, `hydrateQueue` and `ON_LIBRARY_ALBUM` are what the
 * library sweep reads a queue it rewrites with.
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
            displayTitle: true,
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
        album: t.album ? { id: t.album.id, title: t.album.displayTitle || t.album.title, coverArt: t.album.userCoverUrl || t.album.coverUrl } : null,
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

/**
 * The song ids of a queue a web client sends as entries, in order, and the place it is on counted over those ids. Only
 * an entry's id is read: the song's details are Kima's own (`planQueue`). Entries without an id are dropped, and the
 * index (counted over the entries as sent, a whole number of 0 or more the caller has checked with `isQueueIndex`)
 * moves back by the ones dropped before it, so an index whose own entry was dropped points at the next entry kept.
 */
function queueIdsOf(raw: readonly unknown[], index: number): { ids: string[]; clientIndex: number } {
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
function pointIntoStored(stored: readonly QueueEntry[], clientIndex: number, trackId: unknown, playable: ReadonlySet<string>): number {
    if (stored.length === 0) return 0;
    const shownAt = stored.flatMap((item, i) => (playable.has(item.id) ? [i] : []));
    const counted = Math.min(clientIndex, stored.length - 1);
    const mapped = shownAt.length === 0 ? counted : shownAt[Math.min(clientIndex, shownAt.length - 1)];
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

/** Whether a save names a song: an id that is text and not empty. */
const namesSong = (trackId: unknown): trackId is string => typeof trackId === "string" && trackId !== "";

/** Whether a value is a place in a queue: a whole number of 0 or more. */
const isQueueIndex = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Whether a save that sends no queue says where the player is: an index, or the song it is on. */
function namesCurrentSong(clientIndex: unknown, trackId: unknown): boolean {
    return typeof clientIndex === "number" || namesSong(trackId);
}

/**
 * Takes the person's turn to save, then their state row, until the transaction ends. The turn is a lock on the person
 * (a first save has no row yet, and two saves of one person never meet); the row is what the library sweep rewriting a
 * queue waits on. The one lock every save takes, web or Subsonic.
 */
async function lockPlaybackState(tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">, userId: string): Promise<void> {
    await takeTurn(tx, userId);
    await lockStateRow(tx, userId);
}

async function takeTurn(tx: Pick<Prisma.TransactionClient, "$executeRaw">, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`playback-state:${userId}`}, 0))`;
}

async function lockStateRow(tx: Pick<Prisma.TransactionClient, "$queryRaw">, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT "userId" FROM "PlaybackState" WHERE "userId" = ${userId} FOR UPDATE`;
}

/**
 * The index to store for a save that sends no queue, worked out against the queue as it stands. The state row is
 * locked first, so a queue being written at the same moment finishes first and the index points into that queue, and
 * the caller's write, in the same transaction, lands before any other.
 *
 * A save that names a song the stored queue does not hold (an empty queue holds none), with or without an index,
 * moves nothing: the result is `null`, so the stored index stays, and the caller leaves the stored song alone too, as
 * the stored song is always the stored queue's current entry. Otherwise, with an index, a person with no stored queue
 * gets 0; a save that names the song but sends no index finds it in the stored queue (the place nearest the stored
 * index, when it sits twice).
 */
async function indexIntoStoredQueue(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw" | "playbackState" | "track">,
    userId: string,
    clientIndex: number | null | undefined,
    trackId: unknown,
): Promise<number | null> {
    await lockPlaybackState(tx, userId);
    const state = await tx.playbackState.findUnique({ where: { userId }, select: { queue: true, currentIndex: true } });
    const stored = entriesOf(state?.queue);
    if (namesSong(trackId) && !stored.some((item) => item.id === trackId)) return null;
    if (typeof clientIndex !== "number") return placeNearest(stored, trackId, state?.currentIndex ?? 0);
    if (stored.length === 0) return 0;
    const playable = new Set(
        (await tx.track.findMany({ where: { id: { in: stored.map((item) => item.id) }, ...PLAYABLE_SONG }, select: { id: true } })).map((t) => t.id),
    );
    return pointIntoStored(stored, clientIndex, trackId, playable);
}

/** A playback state row as stored. */
type PlaybackStateRow = Prisma.PlaybackStateGetPayload<object>;

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
async function holdSongs(tx: Pick<Prisma.TransactionClient, "$queryRaw">, ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Track" WHERE id = ANY(${[...new Set(ids)]}::text[]) ORDER BY id FOR KEY SHARE`;
    return new Set(rows.map((row) => row.id));
}

/**
 * What a stored queue holds songs to: a song on a library album (the same check the listens module makes of a play's
 * album), which is a Discover song's only exclusion. It is not the playable-song rule: a song whose file is missing or
 * corrupt is stored (it may come back) and hidden when the queue is read.
 */
export const ON_LIBRARY_ALBUM = { album: { location: "LIBRARY" } } satisfies Prisma.TrackWhereInput;

/**
 * What a save that sends song ids takes before it reads them, the order the sweep takes them in so the two never wait
 * on each other: the person's turn, then the songs (`holdSongs`), then the person's state row. Held until the
 * transaction ends. A save with no ids to hold (`ids` empty) holds no song and takes only the turn and the state row.
 *
 * Only the songs the queue will store are held: the ids that are a library song, cut to the first `limit` of them, in
 * id order. Those are returned, and `planQueue` reads only those. A song left out or cut is not stored, so it is not
 * waited for. The limit is read before the transaction opens (`queueLimit`), never here.
 *
 * A save that stores no queue but names a song (the one the player is on) takes it with a `limit` of 1: the song is
 * held the same way, and is stored as named only when it is among the songs returned.
 */
async function lockForQueueSave(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw" | "track">,
    userId: string,
    ids: readonly string[],
    limit: number,
): Promise<ReadonlySet<string>> {
    await takeTurn(tx, userId);
    const storable =
        ids.length === 0 ? new Set<string>() : new Set((await tx.track.findMany({ where: { id: { in: [...new Set(ids)] }, ...ON_LIBRARY_ALBUM }, select: { id: true } })).map((t) => t.id));
    const candidates = ids.filter((id) => storable.has(id));
    const taken = new Set<string>();
    // That read takes no lock, so a song it saw may be gone once the hold gets its turn (the sweep retired it): the
    // hold comes back short, and the next songs in line are held to fill the places it left, until the queue is full.
    for (let start = 0, end = Math.min(limit, candidates.length); start < end; ) {
        for (const id of await holdSongs(tx, candidates.slice(start, end))) taken.add(id);
        start = end;
        // Places, not songs: only the places looked at count, so a repeat further down the list takes none of the room.
        const stored = candidates.slice(0, end).filter((id) => taken.has(id)).length;
        end = Math.min(candidates.length, end + Math.max(0, limit - stored));
    }
    await lockStateRow(tx, userId);
    return taken;
}

/**
 * Whether the id a web player sends for the episode it is on names one Kima holds: `<podcast id>:<episode id>`, with
 * the episode belonging to that podcast. Anything else (another shape, an episode of another show, one that was
 * removed) names nothing. Read under the person's turn, so it agrees with the state it is stored in.
 */
async function namesEpisode(tx: Pick<Prisma.TransactionClient, "podcastEpisode">, podcastId: unknown): Promise<boolean> {
    if (typeof podcastId !== "string") return false;
    const parts = podcastId.split(":");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return false;
    return (await tx.podcastEpisode.findFirst({ where: { id: parts[1], podcastId: parts[0] }, select: { id: true } })) !== null;
}

/**
 * A queue sent as song ids, made into what is stored, read under the locks `lockForQueueSave` took: the entries are
 * Kima's own description of each song. Ids Kima does not know, and songs on a Discover album, are left out; a song whose
 * file is missing or corrupt is kept (it is hidden when the queue is read). The queue is cut to `limit` after those are
 * left out, and `clientIndex` (counting `ids`) is carried over to where its place now sits: the places before it that
 * were left out no longer count, and an index whose own place was left out or cut points at the place standing in for
 * it, the last one at most. `placeKept` is whether the place itself is in the stored queue. No song kept stores no
 * queue, index 0. Of the songs a client sends, only the `held` ones `lockForQueueSave` returned are read. The hidden songs
 * kept from the stored queue are read unheld (they are the stored row's, which the lock on that row covers): a sweep
 * retiring one at the same moment strips it from the queue again once this save commits.
 *
 * A client is shown only the playable songs, so the ids it sends back lack the hidden songs the person's stored queue
 * holds: those stay (`hiddenBehind`), and the index, which counts what the client was shown, is carried over to the
 * stored place of that song. They never push a song the client sent out of the limit. A hidden song that is gone from
 * the library is not brought back. `sameAsShown` is whether the client is shown the same queue and place as the stored
 * state shows it, with the stored current song itself shown (a position belongs to its song, so a stand-in is never
 * "the same"), so a save that only sends back what it was shown changes nothing it can see.
 */
async function planQueue(
    tx: Pick<Prisma.TransactionClient, "track" | "playbackState">,
    userId: string,
    ids: string[],
    clientIndex: number,
    limit: number,
    held: ReadonlySet<string>,
): Promise<{ queue: QueueEntry[] | null; currentIndex: number; placeKept: boolean; sameAsShown: boolean }> {
    const known = await hydrateQueue(ids.filter((id) => held.has(id)), tx, ON_LIBRARY_ALBUM);
    const sent = known.slice(0, limit);
    const place = storedPlaceOf(ids, new Set(known.map((item) => item.id)), sent.length, clientIndex);

    const state = await tx.playbackState.findUnique({ where: { userId }, select: { queue: true, currentIndex: true } });
    const storedIds = entriesOf(state?.queue).map((item) => item.id);
    const every = [...new Set([...sent.map((item) => item.id), ...storedIds])];
    const playable = new Set(
        every.length === 0 ? [] : (await tx.track.findMany({ where: { id: { in: every }, ...PLAYABLE_SONG }, select: { id: true } })).map((t) => t.id),
    );

    const behind = hiddenBehind(sent.map((item) => item.id), storedIds, playable);
    const described = new Map(
        (await hydrateQueue([...new Set([...behind.values()].flat())], tx, ON_LIBRARY_ALBUM)).map((item) => [item.id, item] as const),
    );
    let room = limit - sent.length;
    const queue: QueueEntry[] = [];
    const sentAt: number[] = [];
    for (let at = 0; at <= sent.length; at++) {
        for (const id of behind.get(at) ?? []) {
            const hidden = described.get(id);
            if (hidden && room > 0) {
                queue.push(hidden);
                room--;
            }
        }
        if (at < sent.length) {
            sentAt.push(queue.length);
            queue.push(sent[at]);
        }
    }
    const currentIndex = sent.length > 0 ? sentAt[place.index] : 0;

    const isPlayable = (id: string) => playable.has(id);
    const before = shownPlace(storedIds, state?.currentIndex ?? 0, isPlayable);
    const after = shownPlace(queue.map((item) => item.id), currentIndex, isPlayable);
    const sameAsShown = state !== null && before.onPlace && before.index === after.index && before.ids.length === after.ids.length && before.ids.every((id, at) => id === after.ids[at]);
    return { queue: queue.length > 0 ? queue : null, currentIndex, placeKept: place.placeKept, sameAsShown };
}

/**
 * Where the songs a stored queue holds but a client was not shown (the missing and the corrupt: hidden on read, kept in
 * case they come back) go back in a queue that client sends. Each stays beside the song before it in the stored queue,
 * or, at the head, in front of the song after it, whichever of those the sent queue still holds; a queue sent with
 * none of the stored songs is a new queue and takes none of them. A stored song is matched to the sent queue in order
 * (the first place of its id at or after the last one matched), so a song listed twice is two places. The result is, for
 * each place in the sent queue (and one past its end), the ids of the stored hidden songs that go in front of it.
 */
function hiddenBehind(sent: readonly string[], stored: readonly string[], playable: ReadonlySet<string>): Map<number, string[]> {
    const behind = new Map<number, string[]>();
    const put = (at: number, id: string) => behind.set(at, [...(behind.get(at) ?? []), id]);
    const atHead: string[] = [];
    const sentSet = new Set(sent);
    let cursor = 0;
    let anchored = false;
    for (const id of stored) {
        const at = sent.indexOf(id, cursor);
        if (at >= 0) {
            if (!anchored) atHead.forEach((hidden) => put(at, hidden));
            anchored = true;
            cursor = at + 1;
        } else if (!playable.has(id) && !sentSet.has(id)) {
            if (anchored) put(cursor, id);
            else atHead.push(id);
        }
    }
    return behind;
}

/**
 * What a client is shown of a queue: the songs it can play, in order, and the place it is on counted over those. A place
 * that is not a playable song is stood in for by the next playable one, the last one at most.
 */
function shownPlace(
    ids: readonly string[],
    index: number,
    isPlayable: (id: string) => boolean,
): { ids: string[]; index: number; onPlace: boolean } {
    const shown = ids.filter(isPlayable);
    const placeIn = Math.min(Math.max(index, 0), Math.max(ids.length - 1, 0));
    const before = ids.slice(0, placeIn).filter(isPlayable).length;
    return {
        ids: shown,
        index: shown.length === 0 ? 0 : Math.min(before, shown.length - 1),
        // Whether the place itself is shown, and not a song standing in for it.
        onPlace: ids.length > 0 && isPlayable(ids[placeIn]),
    };
}

const INT32_MAX = 2_147_483_647;
/** The wait for the row lock counts toward a transaction's time limit (5 s by default), and a long queue takes a while to read. */
const SAVE_TIMEOUT_MS = 30_000;

/**
 * A queue a Subsonic app saves, as song ids and the place it is on (`clientIndex` counts `ids`). The songs and the
 * person's state row are locked first (`lockForQueueSave`: the sweep waits on the row only when the queue holds a song
 * it retires, and a first save has no row at all), then the songs are read, the index worked out and the queue written
 * in the same transaction, so a library sweep retiring a song at the same moment finishes first and the queue never
 * stores what it took out, and a web save meeting this one leaves one whole save. What is left out, and how the queue is
 * cut and the index carried over, and which hidden songs of the stored queue stay (the app was shown the playable ones
 * only), is `planQueue`'s; when a save sends a current song that is left out, the song now in its place is current, from its
 * start. The position is kept when the current place itself is kept, not when another place holds its song; a current
 * song that is hidden (missing or corrupt) keeps the position in the row, and a read shows the song standing in for it
 * from 0 until the file returns. The queue limit is
 * read before the transaction opens. The index and the position are whole numbers of 0 or more, as the Subsonic reader
 * has checked them; anything else is a caller's mistake and throws before the database is touched.
 */
export async function saveQueueOfIds(
    userId: string,
    save: { ids: string[]; clientIndex: number; position: number; changedBy: string },
): Promise<void> {
    if (!isQueueIndex(save.clientIndex) || !isQueueIndex(save.position)) {
        throw new TypeError("saveQueueOfIds: the index and the position are whole numbers of 0 or more");
    }
    const limit = await queueLimit();
    await prisma.$transaction(async (tx) => {
        const held = await lockForQueueSave(tx, userId, save.ids, limit);
        const plan = await planQueue(tx, userId, save.ids, save.clientIndex, limit, held);
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
    /**
     * For a track state that names a track: the current song of the shown queue, or with no queue shown the track named
     * while it is playable. None when it names none. A podcast or audiobook state: the track as stored.
     */
    trackId: string | null;
}

export async function playableQueue(
    state: { playbackType: string; queue: unknown; currentIndex: number; position: number; trackId?: string | null } | null,
): Promise<PlayableQueue> {
    const saved = entriesOf(state?.queue);
    const named = state?.trackId ?? null;
    const shownTrack = state?.playbackType === "track" && named !== null;
    const asked = [...saved.map((item) => item.id), ...(shownTrack ? [named] : [])];
    const now = new Map(
        asked.length === 0
            ? []
            : (await prisma.track.findMany({ where: { id: { in: asked }, ...PLAYABLE_SONG }, select: DESCRIBED })).map(
                  (t) => [t.id, describeSong(t)] as const,
              ),
    );
    // Each song is shown as it is now (an edited title, a renamed artist, a new cover), not as it was when saved.
    const queue = saved.flatMap((item) => now.get(item.id) ?? []);
    const { index: currentIndex, onPlace } = shownPlace(saved.map((item) => item.id), state?.currentIndex ?? 0, (id) => now.has(id));
    // A track state that names a track is shown the current song of the queue as shown (a stand-in when the stored one
    // is hidden), whatever the stored name says. With no queue shown, the name stays only while that song is playable.
    // No name stays none. A podcast or audiobook state is not music playback: it keeps the music queue underneath and
    // returns the track as stored. `shownPlace` gives an index into the shown queue whenever it holds a song.
    let trackId: string | null = named;
    if (shownTrack) trackId = queue.length > 0 ? queue[currentIndex].id : now.has(named) ? named : null;
    return {
        queue,
        currentIndex,
        // The position is the saved current song's own: a song standing in for a hidden current one starts from 0.
        position: onPlace ? (state?.position ?? 0) : 0,
        trackId,
    };
}

/**
 * A playback state row as a client is shown it, whether it asked for it or has just saved it: only the queue's playable
 * songs, the index into those, and, for a track state that names a track, the shown queue's current song as the track. What
 * is stored stays as it is. No row stays no row.
 */
async function shownState(state: PlaybackStateRow | null) {
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

// The time of a state as the server answers it (`updatedAt` in JSON): an ISO 8601 date and time with its zone.
const SEEN_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The time of the state a save or a clear says it saw (`expectedUpdatedAt`), or null when what was sent is not one:
 * not text, or not an ISO 8601 date and time with its zone. `new Date` alone would take "1" as a year and "2026-01-01"
 * as midnight, times the server never answered, and a check against one of those can only fail.
 */
function seenTime(raw: unknown): Date | null {
    if (typeof raw !== "string" || !SEEN_TIME.test(raw)) return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The answer to a save or a clear that named a time other than the stored one (409): the state as stored now, shown as
 * a read shows it, so the client can take it up without asking again. The one body both answer with.
 */
async function changedSinceRead(current: PlaybackStateRow | null) {
    return { error: "Playback state changed since it was read", state: await shownState(current) };
}

/** What a refused request is logged as (`reason`, which never carries a value the client sent) and, when it has one, what the client is told. */
export type Refusal = { reason: string; answer?: string };

/** A playback state as a client is shown it (null: none), and the answer to a save or clear that named a stale time. */
export type ShownState = Awaited<ReturnType<typeof shownState>>;
export type ChangedAnswer = Awaited<ReturnType<typeof changedSinceRead>>;

/** A web save, read from a request body: every field is the shape the save needs, or left out. */
export type WebSave = {
    playbackType: "track" | "audiobook" | "podcast";
    trackId?: string | null;
    audiobookId?: string | null;
    podcastId?: string | null;
    /** The entries the client sent, of which only the ids are read. Left out unless the client sent an array. */
    queue?: readonly unknown[];
    currentIndex?: number;
    isShuffle?: boolean;
    /** Where the queue came from (a short page address such as `album:<id>`); null when none was sent or it is not one. */
    queueSource: string | null;
    /** The time of the state the client saw (`updatedAt`): the save writes only while that is still the stored time. */
    seenAt: Date | null;
};

const PLAYBACK_TYPES = ["track", "audiobook", "podcast"] as const;
const SEEN_TIME_REQUIRED = "expectedUpdatedAt: an ISO date and time required";
const INDEX_REQUIRED = "currentIndex: a whole number of 0 or more required";
// A queue source is a short page address such as `album:<id>`; anything longer is not one and is dropped.
const MAX_QUEUE_SOURCE_LENGTH = 200;
/** Who saved the queue, as a Subsonic app reads it (`changedBy`): a save from the web is Kima's. */
const CHANGED_BY = "Kima";

/**
 * A web save as its request body sends it, or why it is refused. A refusal is for a person's mistake and is answered
 * before the database is touched: a type that is none of the three, a time that is not an ISO date and time (a save
 * naming one is the client saying which state it decided on), an index that is no place in a queue (not clamped to
 * one), or an id that is not text or null (a number or object would be stored as the id of a song that cannot exist).
 * A client that predates the time sends none, and its save then writes whatever is stored.
 */
export function readWebSave(body: unknown): { save: WebSave } | { refused: Refusal } {
    const sent = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const { playbackType, trackId, audiobookId, podcastId, queue, currentIndex, isShuffle, queueSource, expectedUpdatedAt } = sent;

    if (!PLAYBACK_TYPES.some((type) => type === playbackType)) {
        return { refused: { reason: "playbackType: track, audiobook or podcast required", answer: "playbackType must be track, audiobook or podcast" } };
    }
    let seenAt: Date | null = null;
    if (expectedUpdatedAt !== undefined) {
        seenAt = seenTime(expectedUpdatedAt);
        if (!seenAt) return { refused: { reason: SEEN_TIME_REQUIRED } };
    }
    // Null is left out.
    if (currentIndex !== undefined && currentIndex !== null && !isQueueIndex(currentIndex)) {
        return { refused: { reason: INDEX_REQUIRED } };
    }
    for (const [name, value] of [["trackId", trackId], ["audiobookId", audiobookId], ["podcastId", podcastId]] as const) {
        if (value !== undefined && value !== null && typeof value !== "string") {
            return { refused: { reason: `${name}: text or null required` } };
        }
    }
    return {
        save: {
            playbackType: playbackType as WebSave["playbackType"],
            trackId: trackId as string | null | undefined,
            audiobookId: audiobookId as string | null | undefined,
            podcastId: podcastId as string | null | undefined,
            queue: Array.isArray(queue) ? queue : undefined,
            currentIndex: typeof currentIndex === "number" ? currentIndex : undefined,
            isShuffle: typeof isShuffle === "boolean" ? isShuffle : undefined,
            queueSource: typeof queueSource === "string" && queueSource.length > 0 && queueSource.length <= MAX_QUEUE_SOURCE_LENGTH ? queueSource : null,
            seenAt,
        },
    };
}

/** A person's playback state as a client is shown it; none when they have none. */
export async function readPlaybackState(userId: string) {
    return shownState(await prisma.playbackState.findUnique({ where: { userId } }));
}

/**
 * A web save: the state a player left (what it is playing, its queue and place, shuffle), written under the person's
 * turn. Answers the state as a read of it would show it, so a client holds one shape whichever way it learned it, or,
 * when the save named a time and the stored state is no longer the one saved at it (or is gone), nothing is written and
 * the answer is the state as stored now (`changed`), so the client can take it up without asking again.
 *
 * A save without a `queue` is a partial update (a shuffle toggle, a track change within the queue the client already
 * has): it never clears the stored queue, only an explicit array replaces it, and an omitted field is left alone rather
 * than reset to its default. Only a track save has a queue: the player keeps none for a book or an episode, and sends the
 * same fields (an empty queue, index 0) on those saves all the same. Such a save leaves the stored queue, its index and
 * its source alone, so the music queue is there when the person goes back to it.
 */
export async function saveWebState(
    userId: string,
    save: WebSave,
): Promise<{ saved: ShownState } | { changed: ChangedAnswer }> {
    const { playbackType, trackId, audiobookId, podcastId, queue, currentIndex, isShuffle, queueSource, seenAt } = save;
    const isTrack = playbackType === "track";
    const queueProvided = isTrack && queue !== undefined;
    const indexOnly = isTrack && !queueProvided && namesCurrentSong(currentIndex, trackId);
    const sent = queueProvided ? queueIdsOf(queue, currentIndex ?? 0) : null;
    // The limit is read here, before the transaction opens: the read may take a connection of its own, and a save
    // holding one must not wait for a second. A save that sends no queue holds at most the one song it names.
    const limit = sent ? await queueLimit() : 1;

    // The queue as it will be stored: the songs of the ids sent, as Kima describes them, cut to the limit.
    const replacementFor = async (tx: Prisma.TransactionClient, ids: string[], clientIndex: number, held: ReadonlySet<string>) => {
        const planned = await planQueue(tx, userId, ids, clientIndex, limit, held);
        return {
            currentIndex: planned.currentIndex,
            // Whether the client is shown the queue and place it already was, which is when its position stays.
            sameAsShown: planned.sameAsShown,
            // The current song is the stored queue's current entry, whatever `trackId` the save sent or left out: a
            // named song the plan left out (unknown, on a Discover album) or cut at the limit never stays beside
            // a queue that does not hold it, so the two never disagree.
            trackId: planned.queue?.[planned.currentIndex]?.id ?? null,
            storedQueue: planned.queue === null ? Prisma.DbNull : (planned.queue as unknown as Prisma.InputJsonValue),
            // Where the queue came from belongs to the queue it was saved with: a save that replaces the queue and
            // sends no source (an older client, the iOS app) clears it, and a save without a queue leaves it.
            safeQueueSource: planned.queue !== null ? queueSource : null,
        };
    };
    type Replacement = Awaited<ReturnType<typeof replacementFor>>;

    // `index` null: the save names a song the stored queue does not hold, so the stored index stays.
    // Returns null when the save named a time and the stored state is no longer the one saved at it (or is gone):
    // nothing was written.
    // `named`: the song and the episode the save names, as they are stored, which is null for an id that names
    // nothing Kima holds; undefined where the stored one is left alone (the save names none and sends no queue, or
    // names a song the stored queue does not hold). A save that replaces the queue always names its current entry
    // as the song.
    // `startsOver`: the save changes the queue or the entry the state is on, so the position goes back to 0. A
    // save that leaves the place alone, a queue re-saved as it stands included, leaves the position alone.
    const write = async (
        db: Pick<Prisma.TransactionClient, "playbackState">,
        { replacement, index, named, startsOver }: {
            replacement: Replacement | null;
            index: number | null;
            named: { trackId: string | null | undefined; podcastId: string | null | undefined };
            startsOver: boolean;
        },
    ): Promise<PlaybackStateRow | null> => {
        // The position is the place in the current song, which only a Subsonic client sends: it never stays beside a
        // song or a queue it was not reached in.
        const queueUpdate = replacement
            ? {
                  queue: replacement.storedQueue,
                  queueSource: replacement.safeQueueSource,
                  currentIndex: index ?? 0,
                  ...(startsOver ? { position: 0 } : {}),
              }
            : indexOnly && index !== null
              ? { currentIndex: index, ...(startsOver ? { position: 0 } : {}) }
              : {};
        const update = {
            playbackType,
            // Omitted fields are left alone: native clients send partial updates (a queue save names its own song).
            ...(named.trackId !== undefined ? { trackId: named.trackId } : {}),
            // A book is Audiobookshelf's, which Kima does not hold: its id is stored as sent.
            ...(audiobookId !== undefined ? { audiobookId: audiobookId || null } : {}),
            ...(named.podcastId !== undefined ? { podcastId: named.podcastId } : {}),
            ...queueUpdate,
            ...(typeof isShuffle === "boolean" ? { isShuffle } : {}),
            changedBy: CHANGED_BY,
        };
        // One statement matches the time and writes, so two saves naming the same time cannot both write; a
        // state that is gone is never brought back by it.
        if (seenAt) {
            const { count } = await db.playbackState.updateMany({ where: { userId, updatedAt: seenAt }, data: update });
            return count === 0 ? null : db.playbackState.findUnique({ where: { userId } });
        }
        return db.playbackState.upsert({
            where: { userId },
            update,
            create: {
                userId,
                playbackType,
                trackId: named.trackId ?? null,
                audiobookId: audiobookId || null,
                podcastId: named.podcastId ?? null,
                queue: replacement?.storedQueue ?? Prisma.DbNull,
                queueSource: replacement?.safeQueueSource ?? null,
                currentIndex: index ?? 0,
                position: 0,
                isShuffle: isShuffle || false,
                changedBy: CHANGED_BY,
            },
        });
    };

    // The index points into a queue: the one sent, or for a save without one the queue as it stands, which stays
    // locked until this save is written (see `indexIntoStoredQueue`). Every other save takes the same lock, a first
    // save included: a time the save names is checked by the write inside it, and the row a save answers with is
    // the one it wrote and not one a later save made. A save holds the songs it stores or names first and reads
    // them under that lock, so a song the library sweep retires cannot be stored after it; the episode it names is
    // read under the same turn.
    const written = await prisma.$transaction(async (tx) => {
        const held = await lockForQueueSave(tx, userId, sent ? sent.ids : namesSong(trackId) ? [trackId] : [], limit);
        const replacement = sent ? await replacementFor(tx, sent.ids, sent.clientIndex, held) : null;
        const named = {
            trackId: replacement ? replacement.trackId : trackId === undefined ? undefined : namesSong(trackId) && held.has(trackId) ? trackId : null,
            podcastId: podcastId === undefined ? undefined : (await namesEpisode(tx, podcastId)) ? (podcastId as string) : null,
        };
        if (replacement) {
            return write(tx, { replacement, index: replacement.currentIndex, named, startsOver: !replacement.sameAsShown });
        }
        if (!indexOnly) return write(tx, { replacement: null, index: 0, named, startsOver: false });
        const index = await indexIntoStoredQueue(tx, userId, currentIndex, trackId);
        // A song the stored queue does not hold changes nothing, the stored song included.
        if (index === null) return write(tx, { replacement: null, index, named: { ...named, trackId: undefined }, startsOver: false });
        const stored = await tx.playbackState.findUnique({ where: { userId }, select: { queue: true, currentIndex: true } });
        // The stored song is the stored queue's current entry, whatever song the save named beside the index.
        const entry = entriesOf(stored?.queue)[index];
        return write(tx, {
            replacement: null,
            index,
            named: entry ? { ...named, trackId: entry.id } : named,
            startsOver: stored !== null && stored.currentIndex !== index,
        });
    }, { timeout: SAVE_TIMEOUT_MS });

    if (!written) return { changed: await changedSinceRead(await prisma.playbackState.findUnique({ where: { userId } })) };
    return { saved: await shownState(written) };
}

/**
 * Clears a person's playback state (when they stop playback completely). `seen` is what the client sent as the time of
 * the state it saw (`?expectedUpdatedAt=`, as a read answered it): the clear then happens only while that is still the
 * stored time, so a state another device saved since is not wiped by a decision made on the older one (`changed`, the
 * state as stored now, as a save refuses with it). Left out (`undefined`), it clears whatever is stored, because a
 * client that predates the time (the iOS app) sends none. A DELETE carries no body that every proxy forwards, so the
 * time travels in the address, and anything there that is not one time (twice, empty, not an ISO date) is refused.
 *
 * The check and the delete run under the turn every save takes, so a save in flight is either before both or after
 * both; a clear naming no time takes the same turn, so it never lands between a save's reads and its write. Clearing
 * state that is already gone succeeds: clients call this to recover from state pointing at something deleted.
 */
export async function clearPlaybackState(
    userId: string,
    seen: unknown,
): Promise<{ refused: Refusal } | { changed: ChangedAnswer } | { cleared: number }> {
    const at = seen === undefined ? null : seenTime(seen);
    if (seen !== undefined && !at) return { refused: { reason: SEEN_TIME_REQUIRED } };
    const { count, current } = await prisma.$transaction(async (tx) => {
        await lockPlaybackState(tx, userId);
        const { count } = await tx.playbackState.deleteMany({ where: at ? { userId, updatedAt: at } : { userId } });
        return { count, current: at && count === 0 ? await tx.playbackState.findUnique({ where: { userId } }) : null };
    }, { timeout: SAVE_TIMEOUT_MS });
    // A state that is there and is not the one seen: shown as a save shows it, so the client takes it up.
    if (current) return { changed: await changedSinceRead(current) };
    return { cleared: count };
}
