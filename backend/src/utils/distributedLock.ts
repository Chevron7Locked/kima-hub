import { randomBytes } from "crypto";
import { redisClient } from "./redis";
import { LockHeldError, LockUnavailableError } from "./lockErrors";

/** A taken lock. Its token is drawn fresh at each acquire, so it lets go of, and renews, only its own take. */
export interface LockLease {
  /** True when this lease's lock was freed; false when it had already expired or another holder took it since. */
  release(): Promise<boolean>;
  /**
   * Renew the lock's expiry every third of `ttlMs` (the acquire's ttl by default) until the returned stop is called.
   * A process that dies stops renewing, so its lock frees within `ttlMs`.
   */
  keepAlive(ttlMs?: number): () => void;
}

/** Taken, held by someone else, or not known because Redis could not be reached. */
export type LockResult =
  | { outcome: "acquired"; lease: LockLease }
  | { outcome: "held" }
  | { outcome: "unavailable"; error: unknown };

const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

const RENEW_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

export class DistributedLock {
  constructor(private redis: typeof redisClient) {}

  async acquire(key: string, ttlMs: number): Promise<LockResult> {
    const lockKey = `lock:${key}`;
    const token = randomBytes(16).toString("hex");
    try {
      const result = await this.redis.set(lockKey, token, "PX", ttlMs, "NX");
      if (result !== "OK") return { outcome: "held" };
    } catch (error) {
      return { outcome: "unavailable", error };
    }
    return { outcome: "acquired", lease: this.lease(lockKey, token, ttlMs) };
  }

  private lease(lockKey: string, token: string, ttlMs: number): LockLease {
    return {
      release: async () => {
        try {
          return (await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token)) === 1;
        } catch {
          // The lock frees on its own at its ttl.
          return false;
        }
      },
      keepAlive: (renewTtlMs = ttlMs) => {
        let timer: NodeJS.Timeout | null = null;
        const schedule = () => {
          timer = setTimeout(async () => {
            try {
              await this.redis.eval(RENEW_SCRIPT, 1, lockKey, token, String(renewTtlMs));
            } catch {
              // A missed renewal is retried on the next tick; the lock lasts its ttl.
            }
            if (timer) schedule();
          }, Math.max(1, Math.floor(renewTtlMs / 3)));
          timer.unref();
        };
        schedule();
        return () => {
          if (timer) clearTimeout(timer);
          timer = null;
        };
      },
    };
  }

  /** Runs `callback` under the lock. Throws LockHeldError or LockUnavailableError when it cannot be taken. */
  async withLock<T>(key: string, ttlMs: number, callback: () => Promise<T>): Promise<T> {
    const result = await this.acquire(key, ttlMs);
    if (result.outcome === "held") throw new LockHeldError(key);
    if (result.outcome === "unavailable") throw new LockUnavailableError(key, result.error);

    try {
      return await callback();
    } finally {
      await result.lease.release();
    }
  }
}

// Singleton instance
export const distributedLock = new DistributedLock(redisClient);
