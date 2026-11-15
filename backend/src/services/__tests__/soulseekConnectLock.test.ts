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

const ensureConnected = () => (soulseekService as any).ensureConnected(true) as Promise<void>;

it("waits for the other process's connection when the lock is held", async () => {
    jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockHeldError("soulseek:connection"));
    (soulseekService as any).connectPromise = Promise.resolve();
    try {
        await expect(ensureConnected()).resolves.toBeUndefined();
    } finally {
        (soulseekService as any).connectPromise = null;
    }
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

        await service().ensureConnected(false);

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

        await service().ensureConnected(true);

        expect(atLock).toBeLessThan(500);
    });

    it("skips the lock altogether when the wait ended with the client connected", async () => {
        service().failedConnectionAttempts = 1;
        service().lastConnectAttempt = Date.now();
        const withLock = jest.spyOn(distributedLock, "withLock");
        const waiting = service().ensureConnected(false);
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

        await expect(service.ensureConnected(true)).rejects.toBeInstanceOf(LockLostError);

        expect(disconnect).toHaveBeenCalled();
        expect(service.client).toBeNull();
        // A connect the lock was lost under is no failed attempt, so no backoff follows it.
        expect(service.failedConnectionAttempts).toBe(0);
    });
});

it("fails at once with the lock's reason when Redis is down", async () => {
    jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockUnavailableError("soulseek:connection"));

    await expect(ensureConnected()).rejects.toBeInstanceOf(LockUnavailableError);
});
