/**
 * A station's play order, handed out a refill at a time. A station plays every song that matches in an order that
 * spreads each artist's songs (spreadByArtist). A listening session (one `seed`) builds that order once from the pool
 * as it is then and keeps it in Redis, so a later refill reads only its own page, and a song joining or leaving the
 * pool mid-session cannot make the session skip or repeat a song. When the order runs out the station starts the pool
 * over as it is by then, in a new order that does not open with the artist just played or with the songs heard last.
 *
 * Positions count up through every pass: a pass holding `length` songs starts at `start`, and the next at
 * start + length. Redis keeps one session per listener and station, the current pass only:
 * `station:<station>:<listener>` (the seed, start, pass, length, the last song's artist) and `...:ids` (the ids in
 * order, CHUNK to a list entry). A listener starting the station again (a new seed at position 0) replaces it. So
 * Redis holds at most one pool's ids per listener and station: measured 1.4 MB for a pool of 50,000 songs (a station
 * on a 500,000-song library: stations hold about the top 10%, Wildcard the untagged 10%), 14 MB for 500,000. The
 * bound is this, not a Redis memory limit: the same Redis holds the job queues, locks and rate limits, BullMQ works
 * only with no eviction ("the only setting that guarantees the correct behavior of the queues", docs.bullmq.io, Going
 * to production), and a limit without eviction would fail those writes too. A separate Redis database number would
 * not help: the limit is per server.
 *
 * A session Redis does not hold (forgotten, lost, Redis down) is rebuilt from the pool as it is now: the same order
 * for the same seed while the pool has not changed, later passes included (replayPasses). A refill from an older
 * session of the same listener (another tab, after a newer start) is built the same way and served without being
 * kept, so it cannot push out the newer one. Without Redis every refill reads the pool again, as before sessions were
 * kept.
 *
 * Cost of building a pass, measured on this branch's Mac: 44-60 ms for 50,000 songs and 0.5-0.8 s for 500,000,
 * on the request's thread. A worker thread was not used: handing it 500,000 songs costs a copy of the same order of
 * time, and pools that large need a library of about 5 million songs.
 */
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { randomFromSeed, spreadByArtist } from "../../utils/artistSpread";

/**
 * How long a session is kept after its last refill. A refill comes every 100 songs while a station plays (the web
 * player's page): about 5.6 hours at the 202-second average of 68,493 Jamendo songs (the lab's MTG-Jamendo
 * metadata), 7 hours at the W8 testbed library's 256 seconds. 12 hours covers a refill gap and a pause of 5 to 6
 * hours; a session forgotten after that is rebuilt from the pool (replayPasses).
 */
export const SESSION_TTL_S = 12 * 60 * 60;
/**
 * When the pool starts over, the songs from the last this many places stay out of as many first places: a refill, and
 * at most a third of the pool. At a half, the artist rule left some of them early in pools of 16 and 100 songs (1.2
 * and 1.5 on average over 500 tries); at a third, none in pools of 45, 100 and 595 and 0.1 in 16.
 */
export const SEAM_WINDOW = 100;
const seamWindow = (songs: number) => Math.min(SEAM_WINDOW, Math.floor(songs / 3));
/**
 * Ids per Redis list entry, as a JSON array. One id per entry took 0.58 s to write for 500,000 songs; a page (at
 * most 100 songs, the route's cap) reads one or two entries.
 */
const CHUNK = 1000;
/**
 * Most songs replayPasses orders to rebuild a later pass: 20 passes of a 50,000-song pool took 0.54 s, about a first
 * page of a 500,000-song pool. Past it, the pass is rebuilt without the seam rules and can differ from the one the
 * session had.
 */
const REPLAY_LIMIT = 1_000_000;
/** What a seed may be: it names a session, so only plain characters. */
export const SEED_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface StationSong {
    id: string;
    /** The artist the mixes' cap counts (recipes.ts artistSql). */
    artistId: string;
}

/**
 * What a station's refill asks for: `limit` songs. With a `seed`, from position `offset` of that session's order, kept
 * for `listener`; without one, the start of a fresh order. `playable` keeps the ids that can still play; a page left
 * with none is passed over.
 */
export interface StationRequest {
    limit: number;
    seed?: string;
    offset?: number;
    listener?: string;
    playable?: (ids: string[]) => Promise<Set<string>>;
}

export interface StationPage {
    trackIds: string[];
    /** The position to ask from for the next refill; only for a request with a seed. */
    next?: number;
}

export function checkStationRequest({ limit, seed, offset = 0 }: StationRequest): void {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`offset must be a whole number, got ${offset}`);
    if (seed === undefined && offset > 0) throw new RangeError("an offset needs the seed of the order it counts into");
    if (seed !== undefined && !SEED_PATTERN.test(seed)) throw new RangeError("a seed is 1 to 128 letters, digits, - or _");
}

interface Pass {
    start: number;
    pass: number;
    length: number;
    lastArtist: string;
    /** The ids in order, when this refill built the pass; otherwise they are read from Redis. */
    ids: string[] | null;
    /** Whether Redis holds this pass for the session. */
    kept: boolean;
}

/**
 * A refill of `station` (a name unique to the station) from `pool`, which reads its songs (null when it has none
 * yet). The pool is read only when a session starts, starts over, or is not held. A page stops at the end of a pass;
 * the next starts the pool over, so a station ends only when its pool is empty.
 */
export async function stationPage(
    station: string,
    pool: () => Promise<StationSong[] | null>,
    request: StationRequest,
): Promise<StationPage> {
    checkStationRequest(request);
    const { limit, seed, offset = 0, listener, playable = async (ids: string[]) => new Set(ids) } = request;
    if (seed === undefined) {
        const songs = (await pool()) ?? [];
        const ids = spreadByArtist(songs, (s) => s.artistId).slice(0, limit).map((s) => s.id);
        const keep = await playable(ids);
        return { trackIds: ids.filter((id) => keep.has(id)) };
    }

    const key = listener === undefined ? null : `station:${station}:${listener}`;
    const held = key ? await readPass(key) : null;
    let current: Pass | null;
    if (held && held.seed === seed) current = held.pass;
    else current = await rebuild(seed, pool, offset, key !== null && (offset === 0 || held === null) ? key : null);
    if (!current) return { trackIds: [], next: offset };

    let at = Math.max(offset, current.start);
    // A new pass is read from the pool, which holds only playable songs, so a second one with nothing playable means
    // the pool and `playable` disagree: give up rather than go round again.
    let passesStarted = 0;
    for (;;) {
        if (at >= current.start + current.length) {
            if (passesStarted++ > 1) return { trackIds: [], next: at };
            const next = await startOver(key, seed, pool, current);
            if (!next) return { trackIds: [], next: at };
            current = next;
            at = current.start;
        }
        const from = at - current.start;
        const to = Math.min(from + limit, current.length);
        let ids = current.ids?.slice(from, to) ?? (key ? await readIds(key, from, to) : null);
        if (!ids) {
            current = await rebuild(seed, pool, at, null);
            if (!current) return { trackIds: [], next: at };
            ids = current.ids!.slice(at - current.start, at - current.start + limit);
        }
        const keep = await playable(ids);
        const trackIds = ids.filter((id) => keep.has(id));
        at += ids.length;
        // Every song of this page went missing after the session read the pool: the next page, from the same order.
        if (trackIds.length > 0) return { trackIds, next: at };
    }
}

async function readPass(key: string): Promise<{ seed: string; pass: Pass } | null> {
    try {
        const [[, meta]] = (await redisClient
            .multi()
            .hgetall(key)
            .expire(key, SESSION_TTL_S)
            .expire(`${key}:ids`, SESSION_TTL_S)
            .exec())! as [[unknown, Record<string, string>]];
        if (Object.keys(meta).length === 0) return null;
        return {
            seed: meta.seed,
            pass: {
                start: Number(meta.start),
                pass: Number(meta.pass),
                length: Number(meta.length),
                lastArtist: meta.lastArtist,
                ids: null,
                kept: true,
            },
        };
    } catch (error) {
        logger.warn(`[Stations] Could not read ${key} from Redis; rebuilding the order: ${(error as Error).message}`);
        return null;
    }
}

/** Positions `from` to `to` (not included) of the kept pass; null when Redis cannot serve them. */
async function readIds(key: string, from: number, to: number): Promise<string[] | null> {
    if (to <= from) return [];
    try {
        const first = Math.floor(from / CHUNK);
        const chunks = await redisClient.lrange(`${key}:ids`, first, Math.floor((to - 1) / CHUNK));
        const ids = chunks.flatMap((chunk) => JSON.parse(chunk) as string[]).slice(from - first * CHUNK, to - first * CHUNK);
        if (ids.length !== to - from) throw new Error(`expected ${to - from} ids, found ${ids.length}`);
        return ids;
    } catch (error) {
        logger.warn(`[Stations] Could not read ${key} from Redis; rebuilding the order: ${(error as Error).message}`);
        return null;
    }
}

/** Keeps a pass in Redis for the session, replacing whatever the listener had; on failure it still serves this refill. */
async function save(key: string, seed: string, pass: Pass): Promise<void> {
    try {
        const ids = pass.ids!;
        const chunks: string[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) chunks.push(JSON.stringify(ids.slice(i, i + CHUNK)));
        await redisClient
            .multi()
            .del(`${key}:ids`)
            .rpush(`${key}:ids`, ...chunks)
            .del(key)
            .hset(key, { seed, start: pass.start, pass: pass.pass, length: pass.length, lastArtist: pass.lastArtist })
            .expire(key, SESSION_TTL_S)
            .expire(`${key}:ids`, SESSION_TTL_S)
            .exec();
        pass.kept = true;
    } catch (error) {
        logger.warn(`[Stations] Could not keep ${key} in Redis: ${(error as Error).message}`);
    }
}

/** The pass holding `offset` for a session Redis does not hold, kept under `keepAs` when given. */
async function rebuild(
    seed: string,
    pool: () => Promise<StationSong[] | null>,
    offset: number,
    keepAs: string | null,
): Promise<Pass | null> {
    const songs = await pool();
    if (!songs || songs.length === 0) return null;
    const pass = replayPasses(seed, songs, Math.floor(offset / songs.length));
    if (keepAs) await save(keepAs, seed, pass);
    return pass;
}

/**
 * Pass `target` of a seed's session over `songs`, rebuilt as it was built: each pass from its own seed, after the pass
 * before it (its last artist and last songs), so with the pool unchanged it comes back song for song. Past
 * REPLAY_LIMIT songs of work, pass `target` is built alone.
 */
export function replayPasses(seed: string, songs: StationSong[], target: number): Pass {
    const first = target * songs.length <= REPLAY_LIMIT ? 0 : target;
    let pass = orderPass(seed, songs, first, null);
    for (let p = first + 1; p <= target; p++) pass = orderPass(seed, songs, p, pass);
    return pass;
}

/** Pass `pass` of a seed's session over `songs`; after `done`, it does not open with its last artist or songs. */
function orderPass(seed: string, songs: StationSong[], pass: number, done: Pass | null): Pass {
    const random = randomFromSeed(`${seed}\0${pass}`);
    let order: StationSong[];
    if (!done) {
        order = spreadByArtist(songs, (s) => s.artistId, random);
    } else {
        const window = Math.min(seamWindow(songs.length), done.length);
        const heard = new Set(done.ids!.slice(done.length - window));
        order = spreadByArtist(songs, (s) => s.artistId, random, {
            previousArtist: done.lastArtist || undefined,
            recent: (s) => heard.has(s.id),
            window,
        });
    }
    return {
        start: pass * songs.length,
        pass,
        length: songs.length,
        lastArtist: order[order.length - 1].artistId,
        ids: order.map((s) => s.id),
        kept: false,
    };
}

/** The next pass after `done`: the pool as it is now, kept for the session when `done` was. */
async function startOver(
    key: string | null,
    seed: string,
    pool: () => Promise<StationSong[] | null>,
    done: Pass,
): Promise<Pass | null> {
    const songs = await pool();
    if (!songs || songs.length === 0) return null;
    const window = Math.min(seamWindow(songs.length), done.length);
    const tail =
        done.ids?.slice(done.length - window) ??
        (key ? await readIds(key, done.length - window, done.length) : null) ??
        [];
    // The tail stands in for the whole pass: orderPass reads only its last songs and last artist.
    const before: Pass = { ...done, ids: tail, length: tail.length };
    const next = orderPass(seed, songs, done.pass + 1, before);
    next.start = done.start + done.length;
    if (key && done.kept) await save(key, seed, next);
    return next;
}
