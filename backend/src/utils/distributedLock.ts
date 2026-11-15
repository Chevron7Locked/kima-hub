import { randomBytes } from "crypto";
import { redisClient } from "./redis";
import { logger } from "./logger";
import { LockHeldError, LockLostError, LockUnavailableError } from "./lockErrors";

/**
 * What `release` found: "released" (the lock was this lease's and is freed), "lost" (it had expired or another holder
 * had taken it, and was left alone) or "unreachable" (Redis could not be asked; the lock frees on its own at its ttl).
 */
export type ReleaseOutcome = "released" | "lost" | "unreachable";

/** A taken lock. Its token is drawn fresh at each acquire, so it lets go of, and renews, only its own take. */
export interface LockLease {
  /**
   * Aborts, with a LockLostError, once the lock is known to be lost: a renewal found it expired or another holder's,
   * or Redis stayed unreachable for a whole ttl so it has expired. Work that must not run unlocked checks it.
   */
  readonly signal: AbortSignal;
  /** Frees the lock if it is still this lease's. A lost lock is logged, once per lease. A second release answers as the first did. */
  release(): Promise<ReleaseOutcome>;
  /**
   * Renew the lock's expiry every third of the ttl it was acquired with, until the returned stop is called.
   * A process that dies stops renewing, so its lock frees within that ttl.
   */
  keepAlive(): () => void;
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
    return { outcome: "acquired", lease: this.lease(key, token, ttlMs) };
  }

  /** Whether anyone holds the lock now. Throws when Redis cannot be asked. */
  async isHeld(key: string): Promise<boolean> {
    return (await this.redis.exists(`lock:${key}`)) > 0;
  }

  private lease(key: string, token: string, ttlMs: number): LockLease {
    const lockKey = `lock:${key}`;
    const controller = new AbortController();
    let lostLogged = false;
    let released: ReleaseOutcome | null = null;
    let confirmedAt = Date.now();

    const markLost = () => {
      if (!lostLogged) {
        lostLogged = true;
        logger.warn(`[Lock] ${key} was lost: it expired or another holder took it while it was held`);
      }
      if (!controller.signal.aborted) controller.abort(new LockLostError(key));
    };

    return {
      signal: controller.signal,
      release: async () => {
        if (released) return released;
        let outcome: ReleaseOutcome;
        try {
          outcome = (await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token)) === 1 ? "released" : "lost";
        } catch {
          outcome = "unreachable";
        }
        released = outcome;
        if (outcome === "lost") markLost();
        return outcome;
      },
      keepAlive: () => {
        let timer: NodeJS.Timeout | null = null;
        const renew = async () => {
          if (released) return;
          try {
            const kept = await this.redis.eval(RENEW_SCRIPT, 1, lockKey, token, String(ttlMs));
            if (kept === 1) {
              confirmedAt = Date.now();
              return;
            }
            markLost();
            stop();
          } catch {
            // One missed renewal is retried on the next tick; the lock lasts its ttl from the last one that landed.
            if (Date.now() - confirmedAt >= ttlMs) {
              markLost();
              stop();
            }
          }
        };
        const schedule = () => {
          timer = setTimeout(async () => {
            await renew();
            if (timer) schedule();
          }, Math.max(1, Math.floor(ttlMs / 3)));
          timer.unref();
        };
        const stop = () => {
          if (timer) clearTimeout(timer);
          timer = null;
        };
        schedule();
        return stop;
      },
    };
  }

  /**
   * Runs `callback` under the lock, renewing it while the callback runs. The callback is handed a signal that aborts if
   * the lock is lost; a long one checks it at its natural steps and stops. Throws LockHeldError or LockUnavailableError
   * when the lock cannot be taken.
   */
  async withLock<T>(key: string, ttlMs: number, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const result = await this.acquire(key, ttlMs);
    if (result.outcome === "held") throw new LockHeldError(key);
    if (result.outcome === "unavailable") throw new LockUnavailableError(key, result.error);

    const stopRenewal = result.lease.keepAlive();
    try {
      return await callback(result.lease.signal);
    } finally {
      stopRenewal();
      await result.lease.release();
    }
  }
}

// Singleton instance
export const distributedLock = new DistributedLock(redisClient);
