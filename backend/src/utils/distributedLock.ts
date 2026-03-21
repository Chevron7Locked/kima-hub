import { randomBytes } from 'crypto';
import { redisClient } from './redis';

export class DistributedLock {
  private lockValue: string;

  constructor(private redis: typeof redisClient) {
    this.lockValue = randomBytes(16).toString('hex');
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    const lockKey = `lock:${key}`;
    try {
      const result = await this.redis.set(lockKey, this.lockValue, "PX", ttlMs, "NX");
      return result === 'OK';
    } catch (error) {
      // Return false on Redis errors (lock acquisition failed)
      return false;
    }
  }

  async release(key: string): Promise<boolean> {
    const lockKey = `lock:${key}`;
    try {
      // Lua script ensures we only delete if we hold the lock
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      const result = await this.redis.eval(script, 1, lockKey, this.lockValue);
      return result === 1;
    } catch (error) {
      // Return false on Redis errors (lock release failed)
      return false;
    }
  }

  async withLock<T>(
    key: string,
    ttlMs: number,
    callback: () => Promise<T>
  ): Promise<T> {
    const acquired = await this.acquire(key, ttlMs);
    if (!acquired) {
      throw new Error(`Failed to acquire lock: ${key}`);
    }

    try {
      return await callback();
    } finally {
      await this.release(key);
    }
  }
}

// Singleton instance
export const distributedLock = new DistributedLock(redisClient);
