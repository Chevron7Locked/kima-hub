import express from "express";
import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { refuseRequest } from "../utils/errors";
import { LiveQueueEntry, isPublicListener, reportLive } from "../services/liveListening";
import {
    changedSinceRead,
    indexIntoStoredQueue,
    lockForQueueSave,
    lockPlaybackState,
    entriesOf,
    isQueueIndex,
    namesCurrentSong,
    namesEpisode,
    namesSong,
    planQueue,
    queueIdsOf,
    queueLimit,
    SAVE_TIMEOUT_MS,
    seenTime,
    shownState,
    type PlaybackStateRow,
} from "../services/savedQueue";

const router = express.Router();

/** What a refused time is logged as, for a save and a clear alike. */
const SEEN_TIME_REQUIRED = "expectedUpdatedAt: an ISO date and time required";

/** What a refused index is logged as. */
const INDEX_REQUIRED = "currentIndex: a whole number of 0 or more required";

// A queue source is a short page address such as `album:<id>`; anything longer is not one and is dropped.
const MAX_QUEUE_SOURCE_LENGTH = 200;

/** Who saved the queue, as a Subsonic app reads it (`changedBy`): a save from the web is Kima's. */
const CHANGED_BY = "Kima";

/** The limit, for the client, so it does not have to guess. */
router.get("/limit", async (_req, res) => {
    res.json({ maxQueueLength: await queueLimit() });
});

// Get current playback state for the authenticated user
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        res.json(await shownState(await prisma.playbackState.findUnique({ where: { userId } })));
    } catch (error) {
        logger.error("Get playback state error:", error);
        res.status(500).json({ error: "Failed to get playback state" });
    }
});

// Update current playback state for the authenticated user
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const {
            playbackType,
            trackId,
            audiobookId,
            podcastId,
            queue,
            currentIndex,
            isShuffle,
            queueSource,
            expectedUpdatedAt,
        } = req.body;

        if (!["track", "audiobook", "podcast"].includes(playbackType)) {
            return res.status(400).json({ error: "playbackType must be track, audiobook or podcast" });
        }

        // A save may name the time of the state it saw (`updatedAt`, as the server last answered it): it then writes
        // only while that is still the stored time, so a state another device saved since is never overwritten by
        // one decided on older word. Omitted, the save writes whatever is stored, because a client that predates the time sends none.
        let expectedAt: Date | null = null;
        if (expectedUpdatedAt !== undefined) {
            expectedAt = seenTime(expectedUpdatedAt);
            if (!expectedAt) return refuseRequest(req, res, SEEN_TIME_REQUIRED);
        }

        // An index is a place in a queue: a whole number of 0 or more, or left out (null is left out). Anything else is
        // no place, and is refused before the database is touched rather than clamped to one.
        if (currentIndex !== undefined && currentIndex !== null && !isQueueIndex(currentIndex)) {
            return refuseRequest(req, res, INDEX_REQUIRED);
        }

        // An id is text or null: a number or object would be stored as the id of a song that cannot exist.
        for (const [name, value] of [["trackId", trackId], ["audiobookId", audiobookId], ["podcastId", podcastId]] as const) {
            if (value !== undefined && value !== null && typeof value !== "string") {
                return refuseRequest(req, res, `${name}: text or null required`);
            }
        }

        // A request without a `queue` is a partial update — a shuffle toggle, or a
        // track change within the queue the client already has. It must NOT clear
        // the stored queue: only an explicit array replaces it. Same for the fields
        // below; an omitted field is left alone rather than reset to its default.
        //
        // Only a track save has a queue: the player keeps none for a book or an episode, and sends the same fields
        // (an empty queue, index 0) on those saves all the same. Such a save leaves the stored queue, its index and its
        // source alone, so the music queue is there when the person goes back to it.
        const isTrack = playbackType === "track";
        const queueProvided = isTrack && Array.isArray(queue);
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
                safeQueueSource:
                    planned.queue !== null && typeof queueSource === "string" && queueSource.length > 0 && queueSource.length <= MAX_QUEUE_SOURCE_LENGTH
                        ? queueSource
                        : null,
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
            if (expectedAt) {
                const { count } = await db.playbackState.updateMany({ where: { userId, updatedAt: expectedAt }, data: update });
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
        const playbackState = await prisma.$transaction(async (tx) => {
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

        if (!playbackState) {
            // What is stored now, as a client is shown it, so the client can take it up without asking again.
            const current = await prisma.playbackState.findUnique({ where: { userId } });
            return res.status(409).json(await changedSinceRead(current));
        }
        // The reply is the state as a read of it would show it, so a client holds one shape whichever way it learned it.
        res.json(await shownState(playbackState));
    } catch (error) {
        logger.error("Save playback state error:", error);
        res.status(500).json({ error: "Failed to save playback state" });
    }
});

const LIVE_STATUSES = new Set(["playing", "paused", "stopped"]);

function millis(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// The web player's play/pause/seek/track changes, for the public live trip. Players only send
// them when /system/features says so; anyone else still gets a 404, which silences them.
router.post("/live", async (req, res) => {
    try {
        if (!(await isPublicListener(req.user!.id))) {
            return res.status(404).json({ error: "Not available" });
        }
        const { status, trackId, position, duration, queue } = req.body ?? {};
        const positionMs = millis(position);
        const durationMs = millis(duration);
        if (!LIVE_STATUSES.has(status) || typeof trackId !== "string" || !trackId || positionMs === null || durationMs === null) {
            return res.status(400).json({ error: "status, trackId, position and duration are required" });
        }
        const upNext: LiveQueueEntry[] = Array.isArray(queue)
            ? queue
                .filter((e: any) => e && typeof e.trackId === "string" && millis(e.duration) !== null)
                .map((e: any) => ({ trackId: e.trackId, duration: millis(e.duration)! }))
            : [];
        reportLive({ status, trackId, position: positionMs, duration: durationMs, queue: upNext });
        res.json({ ok: true });
    } catch (error) {
        // Not a 404: that would silence the player for the session over one failed lookup.
        logger.error("Live playback report error:", error);
        res.status(500).json({ error: "Failed to report live playback" });
    }
});

// Clear playback state (when user stops playback completely)
router.delete("/", async (req, res) => {
    try {
        const userId = req.user!.id;

        // A clear may name the time of the state it saw (`?expectedUpdatedAt=`, as a read answered it): it then clears
        // only while that is still the stored time, so a state another device saved since is not wiped by a decision
        // made on the older one. Omitted, it clears whatever is stored, because a client that predates the time (the iOS app) sends
        // none. A DELETE carries no body that every proxy forwards, so the time travels in the address.
        const named = req.query.expectedUpdatedAt;
        const seen = named === undefined ? null : seenTime(named);
        if (named !== undefined && !seen) return refuseRequest(req, res, SEEN_TIME_REQUIRED);

        // The check and the delete run under the lock every save takes, so a save in flight is either before both or
        // after both; a clear naming no time takes the same turn, so it never lands between a save's reads and its
        // write. deleteMany, so clearing state that is already gone succeeds: clients call this to recover from state
        // pointing at something deleted.
        const { count, current } = await prisma.$transaction(async (tx) => {
            await lockPlaybackState(tx, userId);
            const { count } = await tx.playbackState.deleteMany({ where: seen ? { userId, updatedAt: seen } : { userId } });
            return { count, current: seen && count === 0 ? await tx.playbackState.findUnique({ where: { userId } }) : null };
        }, { timeout: SAVE_TIMEOUT_MS });
        // A state that is there and is not the one seen: shown as a save shows it, so the client takes it up.
        if (current) return res.status(409).json(await changedSinceRead(current));
        // Cleared, or already gone: what the client wanted gone is gone.
        res.json({ success: true, cleared: count });
    } catch (error) {
        logger.error("Delete playback state error:", error);
        res.status(500).json({ error: "Failed to delete playback state" });
    }
});

export default router;
