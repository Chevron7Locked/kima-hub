/**
 * A lock is taken, found held, or found unavailable (Redis down), and a holder lets go of only what it took:
 * two holders in one process are told apart by the token each acquire drew. A held lock stays held while it
 * is kept alive, and frees on its own once renewal stops, so a process that dies mid-cycle cannot block the
 * next one for long.
 */
import Redis from "ioredis";
import { DistributedLock, distributedLock } from "../distributedLock";
import { LockHeldError, LockLostError, LockUnavailableError } from "../lockErrors";
import { logger } from "../logger";
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

    it("frees the key once the lease is released, and a second release answers as the first did", async () => {
        const first = await distributedLock.acquire(KEY, 5000);
        if (first.outcome !== "acquired") throw new Error("expected the lock");

        expect(await first.lease.release()).toBe("released");
        expect(await first.lease.release()).toBe("released");
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

        expect(await first.lease.release()).toBe("lost");

        expect((await distributedLock.acquire(KEY, 5000)).outcome).toBe("held");
        expect(await second.lease.release()).toBe("released");
    });

    it("a lease that was released does not renew the lock a later holder took", async () => {
        const first = await distributedLock.acquire(KEY, 5000);
        if (first.outcome !== "acquired") throw new Error("expected the lock");
        await first.lease.release();
        const second = await distributedLock.acquire(KEY, 300);
        if (second.outcome !== "acquired") throw new Error("expected the lock after release");

        const stop = first.lease.keepAlive();
        await wait(2000);
        stop();

        // The second holder's 300 ms was not stretched to the first one's 5 s.
        expect(await redisClient.get(`lock:${KEY}`)).toBeNull();
    });
});

describe("lease.keepAlive", () => {
    it("keeps the lock past its expiry while renewed, and lets it expire once stopped", async () => {
        const held = await distributedLock.acquire(KEY, 300);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        const stop = held.lease.keepAlive();
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

/** Another holder takes the key, as if this lease's had expired. */
const stolen = () => redisClient.set(`lock:${KEY}`, "someone-else", "PX", 5000);

describe("lease.release says why it did not free the lock", () => {
    afterEach(() => jest.restoreAllMocks());

    it("says lost, and logs it once, when the lock expired or another holder has it", async () => {
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        const held = await distributedLock.acquire(KEY, 5000);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        await stolen();

        expect(await held.lease.release()).toBe("lost");
        expect(await held.lease.release()).toBe("lost");

        expect(warn.mock.calls.filter(([message]) => String(message).includes(KEY))).toHaveLength(1);
        expect(await redisClient.get(`lock:${KEY}`)).toBe("someone-else");
    });

    it("says released, and logs nothing, for a lock still its own", async () => {
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        const held = await distributedLock.acquire(KEY, 5000);
        if (held.outcome !== "acquired") throw new Error("expected the lock");

        expect(await held.lease.release()).toBe("released");

        expect(warn).not.toHaveBeenCalled();
    });

    it("says unreachable, not lost, when Redis fails the release, logs that once, and asks Redis again on a retry", async () => {
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        const held = await distributedLock.acquire(KEY, 5000);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        jest.spyOn(redisClient, "eval").mockRejectedValueOnce(new Error("connection reset"));

        expect(await held.lease.release()).toBe("unreachable");

        expect(warn.mock.calls.filter(([message]) => String(message).includes("lost"))).toHaveLength(0);
        expect(warn.mock.calls.filter(([message]) => String(message).includes("unreachable"))).toHaveLength(1);
        expect(await held.lease.release()).toBe("released");
        expect(await redisClient.get(`lock:${KEY}`)).toBeNull();
    });
});

describe("a lease that is kept alive says when its lock is lost", () => {
    afterEach(() => jest.restoreAllMocks());

    it("aborts its signal with LockLostError when a renewal finds another holder, and logs once", async () => {
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        const held = await distributedLock.acquire(KEY, 300);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        const stop = held.lease.keepAlive();
        await wait(150);
        expect(held.lease.signal.aborted).toBe(false);

        await stolen();
        await wait(400);
        stop();

        expect(held.lease.signal.aborted).toBe(true);
        expect(held.lease.signal.reason).toBeInstanceOf(LockLostError);
        expect(await redisClient.get(`lock:${KEY}`)).toBe("someone-else");
        await held.lease.release();
        expect(warn.mock.calls.filter(([message]) => String(message).includes(KEY))).toHaveLength(1);
    });

    it("aborts its signal when Redis stays unreachable for the whole ttl, but not for one missed renewal", async () => {
        jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        const held = await distributedLock.acquire(KEY, 600);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        const evalSpy = jest.spyOn(redisClient, "eval").mockRejectedValueOnce(new Error("connection reset"));
        const stop = held.lease.keepAlive();
        await wait(350);
        expect(held.lease.signal.aborted).toBe(false);

        evalSpy.mockRejectedValue(new Error("connection reset"));
        await wait(900);
        stop();

        expect(held.lease.signal.aborted).toBe(true);
        jest.restoreAllMocks();
        await redisClient.del(`lock:${KEY}`);
    });

    it("does not abort a lease that was released", async () => {
        const held = await distributedLock.acquire(KEY, 300);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        const stop = held.lease.keepAlive();
        await held.lease.release();
        await wait(500);
        stop();

        expect(held.lease.signal.aborted).toBe(false);
    });
});

describe("distributedLock.withLock keeps the lock while the callback runs", () => {
    afterEach(() => jest.restoreAllMocks());

    it("renews past the ttl, so a callback longer than the ttl is still the only holder", async () => {
        const during = await distributedLock.withLock(KEY, 300, async (signal) => {
            await wait(900);
            return { aborted: signal.aborted, other: (await distributedLock.acquire(KEY, 300)).outcome };
        });

        expect(during).toEqual({ aborted: false, other: "held" });
        expect(await redisClient.get(`lock:${KEY}`)).toBeNull();
    });

    it("aborts the callback's signal when the lock is lost, and leaves the callback to decide what to do", async () => {
        jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        const seen = await distributedLock.withLock(KEY, 300, async (signal) => {
            await stolen();
            await wait(400);
            return signal.aborted;
        });

        expect(seen).toBe(true);
        // The release found the lock another holder's and left it.
        expect(await redisClient.get(`lock:${KEY}`)).toBe("someone-else");
    });

    it("stops renewing once the callback has finished", async () => {
        await distributedLock.withLock(KEY, 300, async () => "done");
        expect((await distributedLock.acquire(KEY, 300)).outcome).toBe("acquired");
        await wait(500);
        expect(await redisClient.get(`lock:${KEY}`)).toBeNull();
    });
});

describe("distributedLock.isHeld", () => {
    it("says whether anyone holds the key, and throws when Redis cannot be asked", async () => {
        expect(await distributedLock.isHeld(KEY)).toBe(false);
        const held = await distributedLock.acquire(KEY, 5000);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        expect(await distributedLock.isHeld(KEY)).toBe(true);
        await held.lease.release();
        expect(await distributedLock.isHeld(KEY)).toBe(false);

        const { lock, close } = downLock();
        try {
            await expect(lock.isHeld(KEY)).rejects.toBeDefined();
        } finally {
            await close();
        }
    });
});
