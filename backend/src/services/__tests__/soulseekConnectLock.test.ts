/**
 * Soulseek connects from one process at a time. A connect that finds the lock held waits for the other
 * process's connection; one that finds Redis down has nobody to wait for and fails at once with the reason.
 */
import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { distributedLock } from "../../utils/distributedLock";
import { LockHeldError, LockLostError, LockUnavailableError } from "../../utils/lockErrors";

let before: Record<string, unknown> | null;
let soulseekService: typeof import("../soulseek").soulseekService;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    // Soulseek starts connecting as it loads when it is enabled; it is not.
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", soulseekEnabled: false }, update: { soulseekEnabled: false } });
    invalidateSystemSettingsCache();
    ({ soulseekService } = await import("../soulseek"));
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    soulseekService.disconnect();
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

afterEach(() => jest.restoreAllMocks());

const ensureConnected = () => (soulseekService as any).ensureConnected("force") as Promise<void>;

it("waits for the other process's connection when the lock is held", async () => {
    jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockHeldError("soulseek:connection"));
    (soulseekService as any).connectPromise = Promise.resolve();
    try {
        await expect(ensureConnected()).resolves.toBeUndefined();
    } finally {
        (soulseekService as any).connectPromise = null;
    }
});

describe("a lock another process holds", () => {
    const service = () => soulseekService as any;
    afterEach(() => {
        service().connecting = false;
        service().connectPromise = null;
        service().client = null;
    });

    it("is waited on until it is free, and the connect is then tried once more", async () => {
        const held = new LockHeldError("soulseek:connection");
        const withLock = jest.spyOn(distributedLock, "withLock")
            .mockRejectedValueOnce(held)
            .mockImplementationOnce(async (_key, _ttl, callback) => callback(new AbortController().signal));
        const isHeld = jest.spyOn(distributedLock, "isHeld").mockResolvedValueOnce(true).mockResolvedValue(false);
        const connect = jest.spyOn(service(), "connect").mockResolvedValue(undefined);

        await service().ensureConnected("force");

        expect(isHeld).toHaveBeenCalledTimes(2);
        expect(withLock).toHaveBeenCalledTimes(2);
        expect(connect).toHaveBeenCalledTimes(1);
    });

    it("fails with a plain reason, and does not wait a second time, when it is held again after the wait", async () => {
        const withLock = jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockHeldError("soulseek:connection"));
        jest.spyOn(distributedLock, "isHeld").mockResolvedValue(false);

        await expect(service().ensureConnected("force")).rejects.toThrow("busy in another process");

        expect(withLock).toHaveBeenCalledTimes(2);
    });

    it("answers with Redis's error when it cannot be asked whether the lock is free", async () => {
        jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockHeldError("soulseek:connection"));
        jest.spyOn(distributedLock, "isHeld").mockRejectedValue(new Error("connection reset"));

        await expect(service().ensureConnected("force")).rejects.toThrow("connection reset");
    });
});

describe("a request while the reconnect backoff runs", () => {
    const service = () => soulseekService as any;
    afterEach(() => {
        service().failedConnectionAttempts = 0;
        service().lastConnectAttempt = 0;
        service().connecting = false;
        service().connectPromise = null;
    });

    it("fails at once saying when to try again, and neither sleeps nor takes the lock", async () => {
        service().failedConnectionAttempts = 8; // 128 s, give or take a quarter
        service().lastConnectAttempt = Date.now();
        const withLock = jest.spyOn(distributedLock, "withLock");
        const started = Date.now();

        const failure = await service().ensureConnected("request").catch((err: Error) => err);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/^soulseek is reconnecting, try again in \d+s$/);
        const seconds = Number((failure as Error).message.match(/\d+/)![0]);
        expect(seconds).toBeGreaterThan(90);
        expect(seconds).toBeLessThanOrEqual(160);
        expect(Date.now() - started).toBeLessThan(500);
        expect(withLock).not.toHaveBeenCalled();
    });

    it("connects once the backoff has passed", async () => {
        service().failedConnectionAttempts = 1;
        service().lastConnectAttempt = Date.now() - 5_000;
        const withLock = jest.spyOn(distributedLock, "withLock").mockResolvedValue(undefined);

        await service().ensureConnected("request");

        expect(withLock).toHaveBeenCalledTimes(1);
    });

    it("waits for a connect that is already running, which is no backoff", async () => {
        service().failedConnectionAttempts = 3;
        service().lastConnectAttempt = Date.now();
        service().connecting = true;
        service().connectPromise = new Promise<void>((resolve) => setTimeout(resolve, 100));
        const withLock = jest.spyOn(distributedLock, "withLock");

        await expect(service().ensureConnected("request")).resolves.toBeUndefined();

        expect(withLock).not.toHaveBeenCalled();
    });

    it("is what a search asks for", async () => {
        const ensure = jest.spyOn(service(), "ensureConnected").mockRejectedValue(new Error("stop here"));

        await expect(service().rateLimitedSearch("x")).rejects.toThrow("stop here");

        expect(ensure).toHaveBeenCalledWith("request");
    });

    it("is what a download asks for", async () => {
        const ensure = jest.spyOn(service(), "ensureConnected").mockRejectedValue(new Error("stop here"));

        const result = await service().downloadTrack({ user: "u", file: "f.mp3", size: 1, slots: true, speed: 1 }, "/tmp/x.mp3");

        expect(result).toEqual({ success: false, error: "stop here" });
        expect(ensure).toHaveBeenCalledWith("request");
    });

    it("is not what the startup connect asks for: it is in the background and sleeps", async () => {
        jest.spyOn(service(), "getSettings").mockResolvedValue({ mode: "slskd", enabled: true });
        const ensure = jest.spyOn(service(), "ensureConnected").mockResolvedValue(undefined);

        await service().connectEagerly();

        expect(ensure).toHaveBeenCalledWith("background");
    });
});

describe("the reconnect backoff", () => {
    const service = () => soulseekService as any;
    afterEach(() => {
        service().failedConnectionAttempts = 0;
        service().lastConnectAttempt = 0;
        service().connecting = false;
        service().connectPromise = null;
    });

    it("is waited out before the lock is taken, so the lock is held for a connect and not a sleep", async () => {
        service().failedConnectionAttempts = 1; // a 1 s delay, give or take a quarter
        service().lastConnectAttempt = Date.now();
        const started = Date.now();
        let sleptBeforeLock = -1;
        let ttl = 0;
        jest.spyOn(distributedLock, "withLock").mockImplementation(async (_key, ttlMs) => {
            sleptBeforeLock = Date.now() - started;
            ttl = ttlMs;
        });

        await service().ensureConnected("background");

        expect(sleptBeforeLock).toBeGreaterThanOrEqual(700);
        // A connect takes at most its connect and login timeouts; the lock is renewed while it runs.
        expect(ttl).toBeLessThanOrEqual(60_000);
    });

    it("does not make a forced reconnect wait", async () => {
        service().failedConnectionAttempts = 3;
        service().lastConnectAttempt = Date.now();
        const started = Date.now();
        let atLock = -1;
        jest.spyOn(distributedLock, "withLock").mockImplementation(async () => {
            atLock = Date.now() - started;
        });

        await service().ensureConnected("force");

        expect(atLock).toBeLessThan(500);
    });

    it("skips the lock altogether when the wait ended with the client connected", async () => {
        service().failedConnectionAttempts = 1;
        service().lastConnectAttempt = Date.now();
        const withLock = jest.spyOn(distributedLock, "withLock");
        const waiting = service().ensureConnected("background");
        // Another caller connects while this one is backing off.
        await new Promise((resolve) => setTimeout(resolve, 100));
        service().client = { loggedIn: true, server: { conn: { destroyed: false, writable: true } } };
        try {
            await waiting;
        } finally {
            service().client = null;
        }

        expect(withLock).not.toHaveBeenCalled();
    });

    it("goes back to the backoff when another caller made an attempt while it slept, and makes none of its own", async () => {
        service().failedConnectionAttempts = 1;
        service().lastConnectAttempt = Date.now();
        const connect = jest.spyOn(service(), "connect").mockResolvedValue(undefined);
        const withLock = jest.spyOn(distributedLock, "withLock");
        const waiting = service().ensureConnected("background");
        // Another caller's attempt starts and fails while this one sleeps, which lengthens the backoff.
        await new Promise((resolve) => setTimeout(resolve, 100));
        service().lastConnectAttempt = Date.now();
        service().failedConnectionAttempts = 2;
        const woke = Date.now();
        // Pass the first wake-up (about 1 s) and see that it is still asleep at the old deadline.
        const outcome = await Promise.race([
            waiting.then(() => "done"),
            new Promise((resolve) => setTimeout(() => resolve("asleep"), 1200)),
        ]);

        expect(outcome).toBe("asleep");
        expect(withLock).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        // The caller is waiting out the new, longer backoff; let it end by connecting.
        service().client = { loggedIn: true, server: { conn: { destroyed: false, writable: true } } };
        try {
            await waiting;
        } finally {
            service().client = null;
        }
        expect(Date.now() - woke).toBeGreaterThan(1200);
    });
});

describe("a connect that loses the lock", () => {
    afterEach(() => {
        const service = soulseekService as any;
        service.connecting = false;
        service.connectPromise = null;
        service.client = null;
    });

    it("drops the connection it made, so two processes are not logged in as one account, and fails with LockLostError", async () => {
        const service = soulseekService as any;
        const aborted = new AbortController();
        aborted.abort(new LockLostError("soulseek:connection"));
        jest.spyOn(distributedLock, "withLock").mockImplementation((_key, _ttl, callback) => callback(aborted.signal));
        jest.spyOn(service, "connect").mockImplementation(async () => {
            service.client = { loggedIn: true, destroy: jest.fn(), server: { conn: { destroyed: false, writable: true } } };
        });
        const disconnect = jest.spyOn(service, "forceDisconnect");

        await expect(service.ensureConnected("force")).rejects.toBeInstanceOf(LockLostError);

        expect(disconnect).toHaveBeenCalled();
        expect(service.client).toBeNull();
        // A connect the lock was lost under is no failed attempt, so no backoff follows it.
        expect(service.failedConnectionAttempts).toBe(0);
    });

    it("is connected again once, and succeeds, when the lock was lost only the first time", async () => {
        const service = soulseekService as any;
        const aborted = new AbortController();
        aborted.abort(new LockLostError("soulseek:connection"));
        const withLock = jest.spyOn(distributedLock, "withLock")
            .mockImplementationOnce((_key, _ttl, callback) => callback(aborted.signal))
            .mockImplementationOnce((_key, _ttl, callback) => callback(new AbortController().signal));
        const connect = jest.spyOn(service, "connect").mockImplementation(async () => {
            service.client = { loggedIn: true, destroy: jest.fn(), server: { conn: { destroyed: false, writable: true } } };
        });

        await expect(service.ensureConnected("request")).resolves.toBeUndefined();

        expect(withLock).toHaveBeenCalledTimes(2);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(service.client?.loggedIn).toBe(true);
    });

    it("is connected again only once: a lock lost both times fails with LockLostError", async () => {
        const service = soulseekService as any;
        const aborted = new AbortController();
        aborted.abort(new LockLostError("soulseek:connection"));
        const withLock = jest.spyOn(distributedLock, "withLock").mockImplementation((_key, _ttl, callback) => callback(aborted.signal));
        jest.spyOn(service, "connect").mockResolvedValue(undefined);

        await expect(service.ensureConnected("request")).rejects.toBeInstanceOf(LockLostError);

        expect(withLock).toHaveBeenCalledTimes(2);
    });

    it("tells of the loss, not of the connect error, when the connect then fails", async () => {
        const service = soulseekService as any;
        const aborted = new AbortController();
        aborted.abort(new LockLostError("soulseek:connection"));
        jest.spyOn(distributedLock, "withLock").mockImplementation((_key, _ttl, callback) => callback(aborted.signal));
        jest.spyOn(service, "connect").mockRejectedValue(new Error("connect timed out"));

        await expect(service.ensureConnected("force")).rejects.toBeInstanceOf(LockLostError);
        service.failedConnectionAttempts = 0;
    });
});

it("fails at once with the lock's reason when Redis is down", async () => {
    jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockUnavailableError("soulseek:connection"));

    await expect(ensureConnected()).rejects.toBeInstanceOf(LockUnavailableError);
});
