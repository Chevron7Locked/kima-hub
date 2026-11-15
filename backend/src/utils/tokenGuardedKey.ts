/**
 * A Redis key that holds its owner's token, changed only by that owner. Each move reads the token and acts in one
 * script, so a key that expired and was taken by someone else in between is left alone.
 *
 * Both answer whether the key was this token's and was changed. A Redis failure throws: callers decide what an
 * unreachable Redis means for them.
 *
 * Only the two plain moves live here. A move that also reads or changes a second key (the share play window's open-response
 * count in `routes/share.ts`) is its own script beside the code that owns that second key.
 */
import type { redisClient } from "./redis";

type Redis = Pick<typeof redisClient, "eval">;

const DELETE_IF_TOKEN = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const PEXPIRE_IF_TOKEN = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

/** Deletes the key only while it holds this token. */
export async function deleteIfToken(redis: Redis, key: string, token: string): Promise<boolean> {
  return (await redis.eval(DELETE_IF_TOKEN, 1, key, token)) === 1;
}

/** Sets the key's life to `ttlMs` only while it holds this token. */
export async function pexpireIfToken(redis: Redis, key: string, token: string, ttlMs: number): Promise<boolean> {
  return (await redis.eval(PEXPIRE_IF_TOKEN, 1, key, token, String(ttlMs))) === 1;
}
