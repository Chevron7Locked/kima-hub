/**
 * A lock is taken, found held, or found unavailable (Redis down), and a holder lets go of only what it took:
 * two holders in one process are told apart by the token each acquire drew. A held lock stays held while it
 * is kept alive, and frees on its own once renewal stops, so a process that dies mid-cycle cannot block the
 * next one for long.
 */
import Redis from "ioredis";
import { DistributedLock, distributedLock } from "../distributedLock";
import { LockHeldError, LockUnavailableError } from "../lockErrors";
import { redisClient } from "../redis";
import { closeClient } from "../closeRedisClient";

const KEY = "test:distributed-lock";

beforeAll(async () => {
    if (redisClient.status !== "ready") await new Promise((r) => redisClient.once("ready", r));
});

beforeEach(async () => {
    await redisClient.del(`lock:${KEY}`);
});

afterAll(async () => {
    await redisClient.del(`lock:${KEY}`);
    await closeClient(redisClient);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real client that cannot reach Redis, as the app's own is while Redis is down. */
function downLock() {
    const client = new Redis("redis://127.0.0.1:1", {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        retryStrategy: () => null,
    });
    client.on("error", () => undefined);
    return { lock: new DistributedLock(client), close: () => closeClient(client) };
}

describe("distributedLock.acquire", () => {
    it("says acquired for a free lock and held while someone has it", async () => {
        const first = await distributedLock.acquire(KEY, 5000);
        const second = await distributedLock.acquire(KEY, 5000);

        expect(first.outcome).toBe("acquired");
        expect(second.outcome).toBe("held");
        if (first.outcome === "acquired") await first.lease.release();
    });

    it("says unavailable, not held, when Redis cannot be reached", async () => {
        const { lock, close } = downLock();
        try {
            const result = await lock.acquire(KEY, 5000);

            expect(result.outcome).toBe("unavailable");
        } finally {
            await close();
        }
    });

    it("frees the key once the lease is released, and a second release does nothing", async () => {
        const first = await distributedLock.acquire(KEY, 5000);
        if (first.outcome !== "acquired") throw new Error("expected the lock");

        expect(await first.lease.release()).toBe(true);
        expect(await first.lease.release()).toBe(false);
        expect((await distributedLock.acquire(KEY, 5000)).outcome).toBe("acquired");
    });
});

describe("two holders in one process", () => {
    it("a lease that expired cannot release the lock a later holder took", async () => {
        const first = await distributedLock.acquire(KEY, 100);
        if (first.outcome !== "acquired") throw new Error("expected the lock");
        await wait(200);
        const second = await distributedLock.acquire(KEY, 5000);
        if (second.outcome !== "acquired") throw new Error("expected the lock after expiry");

        expect(await first.lease.release()).toBe(false);

        expect((await distributedLock.acquire(KEY, 5000)).outcome).toBe("held");
        expect(await second.lease.release()).toBe(true);
    });

    it("a lease that expired does not renew the lock a later holder took", async () => {
        const first = await distributedLock.acquire(KEY, 100);
        if (first.outcome !== "acquired") throw new Error("expected the lock");
        await wait(200);
        const second = await distributedLock.acquire(KEY, 300);
        if (second.outcome !== "acquired") throw new Error("expected the lock after expiry");

        const stop = first.lease.keepAlive(5000);
        await wait(450);
        stop();

        // The second holder's 300 ms was not stretched to the first one's 5 s.
        expect(await redisClient.get(`lock:${KEY}`)).toBeNull();
    });
});

describe("lease.keepAlive", () => {
    it("keeps the lock past its expiry while renewed, and lets it expire once stopped", async () => {
        const held = await distributedLock.acquire(KEY, 300);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        const stop = held.lease.keepAlive(300);
        await wait(900);
        expect((await distributedLock.acquire(KEY, 300)).outcome).toBe("held");
        stop();
        await wait(450);
        const after = await distributedLock.acquire(KEY, 300);
        expect(after.outcome).toBe("acquired");
        if (after.outcome === "acquired") await after.lease.release();
    });
});

describe("distributedLock.withLock", () => {
    it("runs the callback under the lock and frees it afterwards, even when it throws", async () => {
        const inside = await distributedLock.withLock(KEY, 5000, async () => {
            expect(await redisClient.get(`lock:${KEY}`)).not.toBeNull();
            return "done";
        });
        expect(inside).toBe("done");
        expect(await redisClient.get(`lock:${KEY}`)).toBeNull();

        await expect(
            distributedLock.withLock(KEY, 5000, async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        expect(await redisClient.get(`lock:${KEY}`)).toBeNull();
    });

    it("throws LockHeldError while another holds it, and leaves that holder's lock alone", async () => {
        const held = await distributedLock.acquire(KEY, 5000);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        const run = jest.fn();

        await expect(distributedLock.withLock(KEY, 5000, run)).rejects.toBeInstanceOf(LockHeldError);

        expect(run).not.toHaveBeenCalled();
        expect(await redisClient.get(`lock:${KEY}`)).not.toBeNull();
        await held.lease.release();
    });

    it("throws LockUnavailableError when Redis cannot be reached", async () => {
        const { lock, close } = downLock();
        try {
            const run = jest.fn();

            await expect(lock.withLock(KEY, 5000, run)).rejects.toBeInstanceOf(LockUnavailableError);
            expect(run).not.toHaveBeenCalled();
        } finally {
            await close();
        }
    });
});
