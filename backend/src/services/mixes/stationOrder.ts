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
 * order, CHUNK to a list entry), and per listener `stations:<listener>`, their sessions by last use. A listener
 * starting a station again (a new seed at position 0) replaces its session, and only the STATIONS_KEPT most recently
 * used stations of a listener are kept. So Redis holds at most STATIONS_KEPT pools' ids per listener: measured 1.4 MB
 * for a pool of 50,000 songs (a station on a 500,000-song library: stations hold about the top 10%, Wildcard the
 * untagged 10%), 14 MB for 500,000. The bound is this, not a Redis memory limit: the same Redis holds the job queues,
 * locks, rate limits and the web login sessions (connect-redis, 7 days, index.ts), BullMQ works only with no eviction
 * ("the only setting that guarantees the correct behavior of the queues", docs.bullmq.io, Going to production), and a
 * limit without eviction would fail those writes too. A separate Redis database number would not help: the limit is
 * per server. Every write that replaces or continues a session is one Lua script (SAVE), so two tabs cannot interleave
 * it, and a page's ids are read in one transaction with the session's seed and start, so a page never mixes two
 * sessions.
 *
 * A session Redis does not hold (forgotten, lost) is rebuilt from the pool as it is now: the same order for the same
 * seed while the pool has not changed, later passes included (replayPasses). A refill from an older session of the
 * same listener (another tab, after a newer start), and any refill while Redis fails to answer, is built the same way
 * and served without being kept, so it cannot push out the newer one. Without Redis every refill reads the pool
 * again, as before sessions were kept.
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
 * Stations a listener keeps sessions for, the most recently used: one playing on each of two devices and one to
 * switch back to. A station pushed out keeps playing, rebuilt from the pool on its next refill (replayPasses).
 */
export const STATIONS_KEPT = 3;
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
 * How deep replayPasses goes to rebuild a later pass: at most REPLAY_PASSES passes after the first and REPLAY_SONGS
 * songs ordered in all. Any request can name an offset, and a seed Redis has never seen looks like a lost session,
 * so these bound the work one request can cause: 200,000 songs is the first page of a 200,000-song pool (about
 * 0.1 s measured), and 1,000 passes of a one-song pool cost a few milliseconds. A real session gets that deep only
 * after 200,000 songs (about 15 months of continuous play at the 202-second average) or 1,000 full passes (70 days
 * for a 30-song pool, longer for any larger one); past either, the pass is rebuilt alone, without the seam rules, and
 * can differ from the one it had.
 */
export const REPLAY_PASSES = 1000;
export const REPLAY_SONGS = 200_000;
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

/** A page with no songs, with `next` only for a request with a seed. */
export function emptyPage({ seed, offset = 0 }: StationRequest): StationPage {
    return seed === undefined ? { trackIds: [] } : { trackIds: [], next: offset };
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

/** Where a session is kept: its own keys and its listener's list of stations. */
interface Session {
    key: string;
    stations: string;
}

/** Redis did not answer; nothing is known about the session, and nothing is written for it. */
const FAILED = Symbol("redis failed");

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

    const session = listener === undefined ? null : { key: `station:${station}:${listener}`, stations: `stations:${listener}` };
    const held = session ? await readPass(session) : null;
    let current: Pass | null;
    if (held && held !== FAILED && held.seed === seed) {
        current = held.pass;
    } else {
        // Kept when this refill starts the session (replacing any other), or the listener holds none for this station
        // (only if still none by the time it is written); never on a failed read.
        const keep: Keep | null =
            session === null || held === FAILED
                ? null
                : offset === 0
                  ? { session, mode: { replace: true } }
                  : held === null
                    ? { session, mode: { absent: true } }
                    : null;
        current = await rebuild(seed, pool, offset, keep);
    }
    if (!current) return { trackIds: [], next: offset };

    let at = Math.max(offset, current.start);
    // A new pass is read from the pool, which holds only playable songs, so a second one with nothing playable means
    // the pool and `playable` disagree: give up rather than go round again.
    let passesStarted = 0;
    for (;;) {
        if (at >= current.start + current.length) {
            if (passesStarted++ > 1) return { trackIds: [], next: at };
            const next = await startOver(session, seed, pool, current);
            if (!next) return { trackIds: [], next: at };
            current = next;
            // The client's position when it falls in the new pass: a pass served without being kept is built again
            // on the next refill, which asks from after this page, not from the pass's start.
            if (at >= current.start + current.length) at = current.start;
        }
        const from = at - current.start;
        const to = Math.min(from + limit, current.length);
        let ids = current.ids ? current.ids.slice(from, to) : await readIds(session!, seed, current.start, from, to);
        if (!ids) {
            // Redis failed, or another tab replaced the session since it was read: this refill builds its own.
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

/**
 * Reads a session and sets its twelve hours again, marking it the listener's most recently used station by Redis's
 * clock (one clock for every backend process). KEYS: the session, its ids, the listener's stations. ARGV: ttl.
 */
const TOUCH = `
local fields = redis.call("HGETALL", KEYS[1])
if #fields == 0 then return fields end
redis.call("EXPIRE", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[2], ARGV[1])
local now = redis.call("TIME")
redis.call("ZADD", KEYS[3], "XX", now[1] * 1000 + math.floor(now[2] / 1000), KEYS[1])
redis.call("EXPIRE", KEYS[3], ARGV[1])
return fields
`;

async function readPass({ key, stations }: Session): Promise<{ seed: string; pass: Pass } | null | typeof FAILED> {
    try {
        const fields = (await redisClient.eval(TOUCH, 3, key, `${key}:ids`, stations, String(SESSION_TTL_S))) as string[];
        if (fields.length === 0) return null;
        const meta: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) meta[fields[i]] = fields[i + 1];
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
        return FAILED;
    }
}

/**
 * Positions `from` to `to` (not included) of the session's pass starting at `start`, read with the session's seed
 * and start in one transaction; null when Redis cannot serve them or the session is no longer that pass of `seed`.
 */
async function readIds({ key }: Session, seed: string, start: number, from: number, to: number): Promise<string[] | null> {
    if (to <= from) return [];
    try {
        const first = Math.floor(from / CHUNK);
        const [[, held], [, chunks]] = (await redisClient
            .multi()
            .hmget(key, "seed", "start")
            .lrange(`${key}:ids`, first, Math.floor((to - 1) / CHUNK))
            .exec())! as [[unknown, (string | null)[]], [unknown, string[]]];
        if (held[0] !== seed || Number(held[1]) !== start) return null;
        const ids = chunks.flatMap((chunk) => JSON.parse(chunk) as string[]).slice(from - first * CHUNK, to - first * CHUNK);
        if (ids.length !== to - from) throw new Error(`expected ${to - from} ids, found ${ids.length}`);
        return ids;
    } catch (error) {
        logger.warn(`[Stations] Could not read ${key} from Redis; rebuilding the order: ${(error as Error).message}`);
        return null;
    }
}

/**
 * Writes a pass for a session and marks it the listener's most recent station by Redis's clock, dropping the sessions
 * of all but their STATIONS_KEPT most recent. Mode "replace" writes whatever is there (a start); "absent" only if the
 * listener holds no session for the station (another tab may have started one meanwhile); "continue" only if the
 * session still holds the pass it follows, named by seed and start. Returns 1 when written.
 * KEYS: the session, its ids, the listener's stations. ARGV: mode, after seed, after start, seed, start, pass,
 * length, last artist, ttl, stations kept, then the id chunks.
 * The dropped sessions' keys are named inside the script, which Redis Cluster refuses; Kima runs one Redis (the
 * compose files and the all-in-one image), where it is allowed.
 */
const SAVE = `
if ARGV[1] == "absent" and redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
if ARGV[1] == "continue" then
    local held = redis.call("HMGET", KEYS[1], "seed", "start")
    if held[1] ~= ARGV[2] or held[2] ~= ARGV[3] then return 0 end
end
redis.call("DEL", KEYS[1], KEYS[2])
for i = 11, #ARGV do redis.call("RPUSH", KEYS[2], ARGV[i]) end
redis.call("HSET", KEYS[1], "seed", ARGV[4], "start", ARGV[5], "pass", ARGV[6], "length", ARGV[7], "lastArtist", ARGV[8])
redis.call("EXPIRE", KEYS[1], ARGV[9])
redis.call("EXPIRE", KEYS[2], ARGV[9])
local now = redis.call("TIME")
redis.call("ZADD", KEYS[3], now[1] * 1000 + math.floor(now[2] / 1000), KEYS[1])
local older = redis.call("ZREVRANGE", KEYS[3], 0, -1)
local kept = 1
for _, key in ipairs(older) do
    if key ~= KEYS[1] then
        if kept < tonumber(ARGV[10]) then
            kept = kept + 1
        else
            redis.call("DEL", key, key .. ":ids")
            redis.call("ZREM", KEYS[3], key)
        end
    end
end
redis.call("EXPIRE", KEYS[3], ARGV[9])
return 1
`;

/** When SAVE writes: see its modes. */
type SaveMode = { replace: true } | { absent: true } | { after: { seed: string; start: number } };

interface Keep {
    session: Session;
    mode: SaveMode;
}

/** Keeps a pass for the session (SAVE); on failure the pass still serves this refill. */
async function save({ key, stations }: Session, seed: string, pass: Pass, mode: SaveMode): Promise<void> {
    try {
        const ids = pass.ids!;
        const chunks: string[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) chunks.push(JSON.stringify(ids.slice(i, i + CHUNK)));
        const written = await redisClient.eval(
            SAVE,
            3,
            key,
            `${key}:ids`,
            stations,
            "replace" in mode ? "replace" : "absent" in mode ? "absent" : "continue",
            "after" in mode ? mode.after.seed : "",
            "after" in mode ? String(mode.after.start) : "",
            seed,
            String(pass.start),
            String(pass.pass),
            String(pass.length),
            pass.lastArtist,
            String(SESSION_TTL_S),
            String(STATIONS_KEPT),
            ...chunks,
        );
        pass.kept = written === 1;
    } catch (error) {
        logger.warn(`[Stations] Could not keep ${key} in Redis: ${(error as Error).message}`);
    }
}

/** The pass holding `offset` for a session Redis does not hold, kept as `keep` says when given. */
async function rebuild(
    seed: string,
    pool: () => Promise<StationSong[] | null>,
    offset: number,
    keep: Keep | null,
): Promise<Pass | null> {
    const songs = await pool();
    if (!songs || songs.length === 0) return null;
    const pass = replayPasses(seed, songs, Math.floor(offset / songs.length));
    if (keep) await save(keep.session, seed, pass, keep.mode);
    return pass;
}

/**
 * Pass `target` of a seed's session over `songs`, rebuilt as it was built: each pass from its own seed, after the pass
 * before it (its last artist and last songs), so with the pool unchanged it comes back song for song. Deeper than
 * REPLAY_PASSES or REPLAY_SONGS, pass `target` is built alone.
 */
export function replayPasses(seed: string, songs: StationSong[], target: number): Pass {
    const deep = target > REPLAY_PASSES || (target + 1) * songs.length > REPLAY_SONGS;
    let pass = orderPass(seed, songs, deep ? target : 0, null);
    for (let p = pass.pass + 1; p <= target; p++) pass = orderPass(seed, songs, p, pass);
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

/**
 * The next pass after `done`: the pool as it is now, kept for the session when `done` was and the session still holds
 * `done`. When the end of `done` cannot be read from Redis, the next pass is replayed instead, and not kept.
 */
async function startOver(
    session: Session | null,
    seed: string,
    pool: () => Promise<StationSong[] | null>,
    done: Pass,
): Promise<Pass | null> {
    const songs = await pool();
    if (!songs || songs.length === 0) return null;
    const window = Math.min(seamWindow(songs.length), done.length);
    const tail = done.ids ? done.ids.slice(done.length - window) : await readIds(session!, seed, done.start, done.length - window, done.length);
    if (!tail) {
        const replayed = replayPasses(seed, songs, done.pass + 1);
        return { ...replayed, start: done.start + done.length };
    }
    // The tail stands in for the whole pass: orderPass reads only its last songs and last artist.
    const next = orderPass(seed, songs, done.pass + 1, { ...done, ids: tail, length: tail.length });
    next.start = done.start + done.length;
    if (session && done.kept) await save(session, seed, next, { after: { seed, start: done.start } });
    return next;
}
