/**
 * A station's play order, handed out a refill at a time. A station plays every song that matches in an order that
 * spreads each artist's songs (spreadByArtist). A listening session (one `seed`) builds that order once from the pool
 * as it is then and keeps it in Redis, so a later refill reads only its own page, and a song joining or leaving the
 * pool mid-session cannot make the session skip or repeat a song. When the order runs out the station starts the pool
 * over as it is by then, in a new order that does not open with the artist just played or with the songs heard last.
 *
 * Positions count up through every pass: a pass holding `length` songs starts at `start`, and the next at
 * start + length. Redis keeps the current pass only: `station:<station>:<seed>` (start, pass, length, the last song's
 * artist) and `station:<station>:<seed>:ids` (the ids in order, CHUNK to a list entry), both forgotten SESSION_TTL_S
 * after the last refill. Size, measured: 1.4 MB for a pool of 50,000 songs (a station on a 500,000-song library:
 * stations hold about the top 10%, Wildcard the untagged 10%), 14 MB for 500,000.
 *
 * Without Redis, or after a session was forgotten, the pass is rebuilt from the pool as it is now, the same order for
 * the same seed while the pool has not changed.
 */
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { randomFromSeed, spreadByArtist } from "../../utils/artistSpread";

/** How long a session's order is kept after its last refill: a day, past a night's pause. */
export const SESSION_TTL_S = 24 * 60 * 60;
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

export interface StationSong {
    id: string;
    /** The artist the mixes' cap counts (recipes.ts artistSql). */
    artistId: string;
}

/**
 * What a station's refill asks for: `limit` songs. With a `seed`, from position `offset` of that session's order;
 * without one, the start of a fresh order.
 */
export interface StationRequest {
    limit: number;
    seed?: string;
    offset?: number;
}

export interface StationPage {
    trackIds: string[];
    /** The position to ask from for the next refill. */
    next: number;
}

export function checkStationRequest({ limit, seed, offset = 0 }: StationRequest): void {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`offset must be a whole number, got ${offset}`);
    if (seed === undefined && offset > 0) throw new RangeError("an offset needs the seed of the order it counts into");
}

interface Pass {
    start: number;
    pass: number;
    length: number;
    lastArtist: string;
    /** The ids in order, when this refill built the pass; otherwise they are read from Redis. */
    ids: string[] | null;
}

/**
 * A refill of `station` (a name unique to the station) from `pool`, which reads its songs (null when it has none
 * yet). The pool is read only when a session starts, starts over, or was forgotten. A page stops at the end of a
 * pass; the next starts the pool over, so a station ends only when its pool is empty.
 */
export async function stationPage(
    station: string,
    pool: () => Promise<StationSong[] | null>,
    request: StationRequest,
): Promise<StationPage> {
    checkStationRequest(request);
    const { limit, seed, offset = 0 } = request;
    if (seed === undefined) {
        const songs = (await pool()) ?? [];
        const trackIds = spreadByArtist(songs, (s) => s.artistId).slice(0, limit).map((s) => s.id);
        return { trackIds, next: trackIds.length };
    }

    const key = `station:${station}:${seed}`;
    let current = (await readPass(key)) ?? (await rebuild(key, seed, pool, offset));
    if (!current) return { trackIds: [], next: offset };
    let at = Math.max(offset, current.start);
    if (at >= current.start + current.length) {
        const next = await startOver(key, seed, pool, current);
        if (!next) return { trackIds: [], next: at };
        current = next;
        at = current.start;
    }
    const from = at - current.start;
    const to = Math.min(from + limit, current.length);
    let trackIds = current.ids?.slice(from, to) ?? (await readIds(key, from, to));
    if (!trackIds) {
        const rebuilt = await rebuild(key, seed, pool, at);
        if (!rebuilt) return { trackIds: [], next: at };
        trackIds = rebuilt.ids!.slice(at - rebuilt.start, at - rebuilt.start + limit);
    }
    return { trackIds, next: at + trackIds.length };
}

async function readPass(key: string): Promise<Pass | null> {
    try {
        const [[, meta]] = (await redisClient
            .multi()
            .hgetall(key)
            .expire(key, SESSION_TTL_S)
            .expire(`${key}:ids`, SESSION_TTL_S)
            .exec())! as [[unknown, Record<string, string>]];
        if (Object.keys(meta).length === 0) return null;
        return {
            start: Number(meta.start),
            pass: Number(meta.pass),
            length: Number(meta.length),
            lastArtist: meta.lastArtist,
            ids: null,
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

/** Keeps a pass in Redis; on failure the pass still serves this refill from memory. */
async function save(key: string, pass: Pass, ids: string[]): Promise<void> {
    try {
        const chunks: string[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) chunks.push(JSON.stringify(ids.slice(i, i + CHUNK)));
        await redisClient
            .multi()
            .del(`${key}:ids`)
            .rpush(`${key}:ids`, ...chunks)
            .del(key)
            .hset(key, { start: pass.start, pass: pass.pass, length: pass.length, lastArtist: pass.lastArtist })
            .expire(key, SESSION_TTL_S)
            .expire(`${key}:ids`, SESSION_TTL_S)
            .exec();
    } catch (error) {
        logger.warn(`[Stations] Could not keep ${key} in Redis: ${(error as Error).message}`);
    }
}

/**
 * The pass holding `offset` for a session Redis does not hold: started now (offset 0) or forgotten. Each pass has its
 * own seed, so with the pool unchanged the passes come back as they were, apart from how a pass met the one before.
 */
async function rebuild(key: string, seed: string, pool: () => Promise<StationSong[] | null>, offset: number): Promise<Pass | null> {
    const songs = await pool();
    if (!songs || songs.length === 0) return null;
    const pass = Math.floor(offset / songs.length);
    const order = spreadByArtist(songs, (s) => s.artistId, randomFromSeed(`${seed}\0${pass}`));
    return keep(key, { start: pass * songs.length, pass, length: songs.length, lastArtist: "", ids: null }, order);
}

/** The next pass after `done`: the pool as it is now, not opening with its last artist or the songs heard last. */
async function startOver(key: string, seed: string, pool: () => Promise<StationSong[] | null>, done: Pass): Promise<Pass | null> {
    const songs = await pool();
    if (!songs || songs.length === 0) return null;
    const window = Math.min(seamWindow(songs.length), done.length);
    const last = done.ids?.slice(done.length - window) ?? (await readIds(key, done.length - window, done.length)) ?? [];
    const heard = new Set(last);
    const pass = done.pass + 1;
    const order = spreadByArtist(songs, (s) => s.artistId, randomFromSeed(`${seed}\0${pass}`), {
        previousArtist: done.lastArtist || undefined,
        recent: (s) => heard.has(s.id),
        window,
    });
    return keep(key, { start: done.start + done.length, pass, length: songs.length, lastArtist: "", ids: null }, order);
}

async function keep(key: string, pass: Pass, order: StationSong[]): Promise<Pass> {
    const ids = order.map((s) => s.id);
    const full = { ...pass, lastArtist: order[order.length - 1].artistId, ids };
    await save(key, full, ids);
    return full;
}
