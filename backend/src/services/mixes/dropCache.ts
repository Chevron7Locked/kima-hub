import type { Redis } from "ioredis";
import { dependsOnMoods } from "./cacheKeys";

/**
 * Drop the cached mixes so the next read rebuilds them; returns how many were dropped. With `moodsOnly`, only the keys
 * a change to the moods makes stale (cacheKeys.ts): the familiarity results, their locks and the energy band stay.
 */
export async function dropCachedMixes(redis: Pick<Redis, "scan" | "del">, moodsOnly = false): Promise<number> {
    const keys: string[] = [];
    let cursor = "0";
    do {
        const [next, batch] = await redis.scan(cursor, "MATCH", "mixes:*", "COUNT", 100);
        cursor = next;
        keys.push(...(moodsOnly ? batch.filter(dependsOnMoods) : batch));
    } while (cursor !== "0");
    if (keys.length > 0) await redis.del(...keys);
    return keys.length;
}
