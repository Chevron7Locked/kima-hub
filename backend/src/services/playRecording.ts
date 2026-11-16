/**
 * What counts as a play, by Last.fm's rule (also ListenBrainz's): the track is
 * longer than 30 seconds and was heard for half its length or four minutes,
 * whichever comes first. An unknown duration (0) gets the four-minute bound,
 * not a pass; half a length has no 30-second floor.
 */

import { ListenSource, Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { listenBrainzService } from "./listenBrainz";
import { hasPlayBetween, listenersOf } from "./stats/listens";

/** A track at or below this length can never be scrobbled. Last.fm's floor. */
export const MIN_TRACK_DURATION_SECONDS = 30;

/** Nobody has to finish a long track. Four minutes is always enough. */
export const MAX_REQUIRED_SECONDS = 240;

/**
 * The shortest window a repeat is ever suppressed for, whatever the track's
 * length. A ten second loop is a stuck client, not a listener.
 */
const MIN_DEDUP_WINDOW_MS = 30 * 1000;

/**
 * How long a repeat of the same track is the same listen: the track's own
 * length, applied on both sides of the reported play. While the song could
 * still be playing, a second report describes the same listen.
 */
export function dedupWindowMs(durationSeconds: number | null | undefined): number {
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return MAX_REQUIRED_SECONDS * 1000;
    }
    return Math.max(MIN_DEDUP_WINDOW_MS, durationSeconds * 1000);
}

export type PlayOutcome =
    | { recorded: true; playId: string }
    | { recorded: false; reason: "too-short" | "not-enough-listened" | "duplicate" | "unknown-track" };

/** Seconds of a track that must be heard before it counts, or `null` when it can never qualify (not a very large
 * number: listening longer cannot satisfy it). */
export function requiredListenSeconds(durationSeconds: number | null | undefined): number | null {
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        // Unknown length. Demand the upper bound rather than waving it through.
        return MAX_REQUIRED_SECONDS;
    }
    if (durationSeconds <= MIN_TRACK_DURATION_SECONDS) return null;
    return Math.min(durationSeconds / 2, MAX_REQUIRED_SECONDS);
}

/**
 * Mirror a committed play to ListenBrainz, fire-and-forget: never awaited,
 * rejections logged as warnings, and a no-op without a user token. A
 * ListenBrainz outage never fails a play.
 */
function mirrorToListenBrainz(params: {
    userId: string;
    artistName: string;
    trackTitle: string;
    releaseTitle?: string | null;
    listenedAt: number; // unix seconds
}): void {
    const { userId, artistName, trackTitle, releaseTitle, listenedAt } = params;
    listenBrainzService
        .submitListens(userId, [
            {
                artist: artistName,
                track: trackTitle,
                ...(releaseTitle ? { release: releaseTitle } : {}),
                listenedAt,
            },
        ])
        .then((ok) => {
            if (ok) {
                logger.debug(`[Play] mirrored "${artistName} – ${trackTitle}" to ListenBrainz`);
            }
        })
        .catch((err: unknown) => {
            logger.warn(
                `[Play] ListenBrainz mirror failed for "${artistName} – ${trackTitle}":`,
                err,
            );
        });
}

/**
 * What the caller knows: `secondsListened` measured by the web player, or
 * `clientAttestedComplete` from a Subsonic scrobble with submission=true, which
 * meets the listening rule but still gets the 30-second floor and duplicate window.
 */
export type PlayEvidence =
    | { secondsListened: number; clientAttestedComplete?: never }
    | { clientAttestedComplete: true; secondsListened?: never };

/**
 * Namespace for the two-integer advisory lock. Postgres keeps one- and
 * two-integer keys apart, so this never contends with playlistService's
 * one-integer `hashtext(playlistId)` locks.
 */
const PLAY_DEDUP_LOCK_NAMESPACE = 7001;

/**
 * Serialise play reports for one (user, track) so the duplicate check and the
 * insert are one decision. Must run inside the transaction under READ COMMITTED:
 * under REPEATABLE READ the waiting writer reads its old snapshot and writes a duplicate.
 */
async function lockPlayDedupe(
    tx: Pick<typeof prisma, "$executeRaw">,
    userId: string,
    trackId: string,
): Promise<void> {
    // Both arguments need the explicit `::int` cast: Prisma binds a JS number
    // as `bigint`, and the two-argument `pg_advisory_xact_lock` only has an
    // `(int, int)` signature — `(bigint, int)` matches nothing and the query
    // fails with 42883 before the first statement even runs.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLAY_DEDUP_LOCK_NAMESPACE}::int, hashtext(${`${userId}:${trackId}`}))`;
}

/**
 * The longest a repair of one listener's history may hold their exclusive history lock. A recording waits on that lock
 * inside its own transaction, so its timeout is this plus a margin: a play reported mid-repair is recorded after it, not lost.
 */
export const PLAY_HISTORY_REPAIR_MAX_MS = 5 * 60_000;

/** A second namespace, for the lock on one listener's whole play history (see `lockPlayHistory`). */
export const PLAY_HISTORY_LOCK_NAMESPACE = 7002;

/**
 * Guards one listener's play history as a whole. Recording a play takes it shared, so recordings never wait for one
 * another; the false-start audit takes it exclusive around its read and delete, so no play lands between the
 * two and a verdict is never carried out on history that has since changed. Taken before the per-track lock, never after.
 * Released with the transaction.
 */
export async function lockPlayHistory(
    tx: Pick<typeof prisma, "$executeRaw">,
    userId: string,
    options: { exclusive?: true } = {},
): Promise<void> {
    if (options.exclusive) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLAY_HISTORY_LOCK_NAMESPACE}::int, hashtext(${userId}))`;
    } else {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${PLAY_HISTORY_LOCK_NAMESPACE}::int, hashtext(${userId}))`;
    }
}

/**
 * Tries each listener's shared history lock once, never waiting, and answers the listeners whose history is being
 * repaired right now (their lock was not given). The locks it did get are held to the end of the transaction, so a repair
 * cannot start on those listeners meanwhile.
 */
export async function listenersWithBusyPlayHistory(tx: Prisma.TransactionClient, userIds: Iterable<string>): Promise<Set<string>> {
    const busy = new Set<string>();
    for (const userId of new Set(userIds)) {
        const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock_shared(${PLAY_HISTORY_LOCK_NAMESPACE}::int, hashtext(${userId})) AS locked`;
        if (!locked) busy.add(userId);
    }
    return busy;
}

/**
 * Which of these songs have a listener whose play history is being repaired right now. For a caller about to move or
 * change those songs' plays that cannot wait for a repair (a library scan never blocks behind a per-user maintenance
 * job): it tries each listener's shared lock once, never waiting, and the songs it names are to be left as they are
 * for a later pass. The locks it did get are held to the end of the transaction, so a repair cannot start on those
 * listeners meanwhile.
 *
 * The caller must already hold the songs' rows locked (`FOR UPDATE`): a play recorded for a song waits on its row, so
 * the listeners read here are all the song will ever have in this transaction.
 */
export async function songsWithBusyPlayHistory(tx: Prisma.TransactionClient, trackIds: string[]): Promise<Set<string>> {
    if (trackIds.length === 0) return new Set();
    const pairs = await listenersOf(tx, trackIds);
    const busyListeners = await listenersWithBusyPlayHistory(tx, pairs.map((p) => p.userId));
    return new Set(pairs.filter((p) => busyListeners.has(p.userId)).map((p) => p.trackId));
}

/**
 * Runs the insert, answering "unknown track" when the song was retired between the lookup and the insert. A library
 * scan retiring a missing song locks its row, so an insert waiting on that row finds it gone once the scan commits: the
 * foreign key refuses it. Nothing was written, and the caller is told so, not handed an error.
 */
async function recordUnlessRetired<T>(trackId: string, insert: () => Promise<T>): Promise<T | { recorded: false; reason: "unknown-track" }> {
    try {
        return await insert();
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
            const stillThere = await prisma.track.findUnique({ where: { id: trackId }, select: { id: true } });
            if (!stillThere) return { recorded: false, reason: "unknown-track" };
        }
        throw err;
    }
}

/**
 * Record a play if the listening earns it. Duration is read from the database,
 * never the request. Check and insert run in one transaction behind a
 * per-(user, track) advisory lock, so concurrent or back-filled reports of one
 * play cannot both write.
 */
export async function recordPlay(
    params: {
        userId: string;
        trackId: string;
        source?: ListenSource;
        playedAt?: Date;
    } & PlayEvidence,
): Promise<PlayOutcome> {
    const { userId, trackId, source = ListenSource.LIBRARY, playedAt } = params;
    const attested = params.clientAttestedComplete === true;

    const track = await prisma.track.findUnique({
        where: { id: trackId },
        select: {
            id: true,
            duration: true,
            title: true,
            album: { select: { title: true, artist: { select: { name: true } } } },
        },
    });
    if (!track) return { recorded: false, reason: "unknown-track" };

    const required = requiredListenSeconds(track.duration);
    if (required === null) return { recorded: false, reason: "too-short" };
    if (!attested) {
        const seconds = params.secondsListened;
        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < required) {
            return { recorded: false, reason: "not-enough-listened" };
        }
    }

    // The window is centred on the play being reported, not started at it.
    // A late sync reports something that happened hours ago; anything newer
    // than that is a different listen and must not veto it.
    const anchor = playedAt?.getTime() ?? Date.now();
    const window = dedupWindowMs(track.duration);

    // No isolationLevel on purpose: READ COMMITTED is what makes the lock work
    // (see lockPlayDedupe).
    const outcome = await recordUnlessRetired(trackId, () => prisma.$transaction(async (tx) => {
        await lockPlayHistory(tx, userId);
        await lockPlayDedupe(tx, userId, trackId);

        // Strict bounds on both sides: exactly one duration away, the song has
        // finished, so that play is a genuine replay. Subsonic clients scrobble exact
        // timestamps, which is where this edge happens.
        const recent = await hasPlayBetween(tx, {
            userId,
            trackId,
            after: new Date(anchor - window),
            before: new Date(anchor + window),
        });
        if (recent) return { recorded: false, reason: "duplicate" } as const;

        const play = await tx.play.create({
            data: { userId, trackId, source, heard: true, ...(playedAt ? { playedAt } : {}) },
            select: { id: true },
        });
        return { recorded: true, playId: play.id } as const;
    }, { timeout: PLAY_HISTORY_REPAIR_MAX_MS + 30_000, maxWait: 60_000 }));

    // Past this point the row is committed (or the duplicate call is over), so
    // nothing below may change `outcome` — the mirror is fire-and-forget.
    if (outcome.recorded) {
        logger.debug(
            attested
                ? `[Play] ${trackId} counted for ${userId} on the client's attestation (${track.duration}s track)`
                : `[Play] ${trackId} counted for ${userId} after ${Math.round(params.secondsListened ?? 0)}s ` +
                      `(needed ${Math.round(required)}s of ${track.duration}s)`,
        );

        // Mirror to ListenBrainz only when we know what was actually played.
        // Mocked/partial track rows (tests, half-enriched libraries) simply
        // skip the mirror; the local play log is unaffected either way.
        if (track.title && track.album?.artist?.name) {
            mirrorToListenBrainz({
                userId,
                artistName: track.album.artist.name,
                trackTitle: track.title,
                releaseTitle: track.album.title,
                // The play's own clock: Subsonic back-fills with the client's
                // timestamp, and LB wants the listen anchored to when it
                // happened, not to when the report arrived.
                listenedAt: Math.floor(anchor / 1000),
            });
        }
    } else {
        logger.debug(
            `[Play] ${trackId} skipped for ${userId}: a play of it is already logged within ` +
                `±${Math.round(window / 1000)}s of ${new Date(anchor).toISOString()}`,
        );
    }

    return outcome;
}
