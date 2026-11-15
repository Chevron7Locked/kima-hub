/**
 * Soulseek connects from one process at a time. A connect that finds the lock held waits for the other
 * process's connection; one that finds Redis down has nobody to wait for and fails at once with the reason.
 */
// The real client unless a test hands one out: connect() asks this for the client to log in with.
jest.mock("../../lib/soulseek/client", () => {
    const actual = jest.requireActual("../../lib/soulseek/client");
    return { ...actual, resolveSlskClient: jest.fn(actual.resolveSlskClient) };
});

import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { distributedLock } from "../../utils/distributedLock";
import { soulseekLogin } from "../soulseekLogin";
import { EventEmitter } from "events";
import { resolveSlskClient } from "../../lib/soulseek/client";
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

/** Lets a connect that is waiting for the server socket to open have it: the socket opens once the connect listens. */
async function whileSocketOpens(connecting: Promise<void>, conn: EventEmitter): Promise<void> {
    const timer = setInterval(() => conn.emit("connect"), 5);
    try {
        await connecting;
    } finally {
        clearInterval(timer);
    }
}

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

    it("does not wait a second time when the lock is lost on the connect that followed the wait", async () => {
        const aborted = new AbortController();
        aborted.abort(new LockLostError("soulseek:connection"));
        const withLock = jest.spyOn(distributedLock, "withLock")
            .mockRejectedValueOnce(new LockHeldError("soulseek:connection"))
            .mockImplementationOnce((_key, _ttl, callback) => callback(aborted.signal))
            .mockRejectedValue(new LockHeldError("soulseek:connection"));
        const isHeld = jest.spyOn(distributedLock, "isHeld").mockResolvedValue(false);
        jest.spyOn(service(), "connect").mockResolvedValue(undefined);

        await expect(service().ensureConnected("force")).rejects.toThrow("busy in another process");

        expect(isHeld).toHaveBeenCalledTimes(1);
        expect(withLock).toHaveBeenCalledTimes(3);
    });

    it("names the real cause, and keeps it as the error's cause, when the connect it waited on fails", async () => {
        const cause = new Error("login refused: invalid password");
        const failed = Promise.reject(cause);
        failed.catch(() => undefined);
        service().connectPromise = failed;

        const failure = await service().waitForConnection().catch((err: Error) => err);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("login refused: invalid password");
        expect((failure as Error).cause).toBe(cause);
    });

    it("answers with Redis's error when it cannot be asked whether the lock is free", async () => {
        jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockHeldError("soulseek:connection"));
        jest.spyOn(distributedLock, "isHeld").mockRejectedValue(new Error("connection reset"));

        await expect(service().ensureConnected("force")).rejects.toThrow("connection reset");
    });
});

describe("the login marker", () => {
    const service = () => soulseekService as any;
    const holder = { by: "other-host:77", at: new Date("2026-11-15T10:00:00Z") };
    afterEach(() => {
        service().connecting = false;
        service().connectPromise = null;
        service().client = null;
    });

    const directLogin = () => jest.spyOn(service(), "getSettings").mockResolvedValue({ mode: "p2p", enabled: true, username: "u", password: "p" });

    it("keeps a process that waited from logging in over another process that is now logged in", async () => {
        directLogin();
        jest.spyOn(distributedLock, "withLock")
            .mockRejectedValueOnce(new LockHeldError("soulseek:connection"))
            .mockImplementation(async (_key, _ttl, callback) => callback(new AbortController().signal));
        jest.spyOn(distributedLock, "isHeld").mockResolvedValue(false);
        jest.spyOn(soulseekLogin, "heldByOther").mockResolvedValue(holder);
        (resolveSlskClient as jest.Mock).mockClear();

        const failure = await service().ensureConnected("request").catch((err: Error) => err);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("another process");
        expect((failure as Error).message).toContain("other-host:77");
        expect(resolveSlskClient).not.toHaveBeenCalled();
    });

    it("keeps the next request of that process from logging in over it as well, whether or not it waited", async () => {
        directLogin();
        jest.spyOn(distributedLock, "withLock").mockImplementation(async (_key, _ttl, callback) => callback(new AbortController().signal));
        jest.spyOn(soulseekLogin, "heldByOther").mockResolvedValue(holder);
        (resolveSlskClient as jest.Mock).mockClear();

        const first = await service().ensureConnected("force").catch((err: Error) => err);
        const second = await service().ensureConnected("force").catch((err: Error) => err);

        expect((first as Error).message).toContain("other-host:77");
        expect((second as Error).message).toContain("other-host:77");
        expect(resolveSlskClient).not.toHaveBeenCalled();
    });

    it("lets a process log in when nobody else is recorded", async () => {
        directLogin();
        jest.spyOn(soulseekLogin, "heldByOther").mockResolvedValue(null);
        jest.spyOn(soulseekLogin, "mark").mockResolvedValue(undefined);
        const only = { loggedIn: false, destroy: jest.fn(), on: jest.fn(), login: jest.fn(), server: { conn: new EventEmitter() } };
        only.login.mockImplementation(async () => { only.loggedIn = true; });
        (resolveSlskClient as jest.Mock).mockReturnValueOnce(function () { return only; });
        await whileSocketOpens(service().connect(), only.server.conn);

        expect(only.login).toHaveBeenCalledTimes(1);
    });

    it("does not look for another login for slskd, which holds the account itself", async () => {
        jest.spyOn(service(), "getSettings").mockResolvedValue({ mode: "slskd", enabled: true, slskdUrl: "http://slskd", slskdApiKey: "k" });
        const heldByOther = jest.spyOn(soulseekLogin, "heldByOther");
        jest.spyOn(soulseekLogin, "mark").mockResolvedValue(undefined);
        const only = { loggedIn: false, destroy: jest.fn(), on: jest.fn(), login: jest.fn(), server: { conn: new EventEmitter() } };
        (resolveSlskClient as jest.Mock).mockReturnValueOnce(function () { return only; });
        await whileSocketOpens(service().connect(), only.server.conn);

        expect(heldByOther).not.toHaveBeenCalled();
    });

    it("is removed when this process drops its connection, by a reset and by a forced disconnect", () => {
        const clear = jest.spyOn(soulseekLogin, "clear").mockResolvedValue(undefined);

        soulseekService.disconnect();
        expect(clear).toHaveBeenCalledTimes(1);

        service().forceDisconnect();
        expect(clear).toHaveBeenCalledTimes(2);
    });
});

describe("a login on the Soulseek server", () => {
    const service = () => soulseekService as any;
    afterEach(() => {
        service().client = null;
        service().connectedAt = null;
    });

    // A fake client whose server socket the test can open and close.
    const fakeClient = () => {
        const conn = new EventEmitter() as EventEmitter & { destroyed: boolean; writable: boolean };
        conn.destroyed = false;
        conn.writable = true;
        const client = { loggedIn: false, destroy: jest.fn(), on: jest.fn(), login: jest.fn(), server: { conn } };
        client.login.mockImplementation(async () => { client.loggedIn = true; });
        return client;
    };
    const connectWith = async (client: ReturnType<typeof fakeClient>) => {
        (resolveSlskClient as jest.Mock).mockReturnValueOnce(function () { return client; });
        await whileSocketOpens(service().connect(), client.server.conn);
    };

    it("is recorded for other processes once a direct login succeeds", async () => {
        jest.spyOn(service(), "getSettings").mockResolvedValue({ mode: "p2p", enabled: true, username: "u", password: "p" });
        const mark = jest.spyOn(soulseekLogin, "mark").mockResolvedValue(undefined);

        await connectWith(fakeClient());

        expect(mark).toHaveBeenCalledTimes(1);
    });

    it("is not recorded for slskd, which holds the account itself", async () => {
        jest.spyOn(service(), "getSettings").mockResolvedValue({ mode: "slskd", enabled: true, slskdUrl: "http://slskd", slskdApiKey: "k" });
        const mark = jest.spyOn(soulseekLogin, "mark").mockResolvedValue(undefined);

        await connectWith(fakeClient());

        expect(mark).not.toHaveBeenCalled();
    });

    it("is not recorded when the login is refused", async () => {
        jest.spyOn(service(), "getSettings").mockResolvedValue({ mode: "p2p", enabled: true, username: "u", password: "p" });
        const mark = jest.spyOn(soulseekLogin, "mark").mockResolvedValue(undefined);
        const refused = fakeClient();
        refused.login.mockRejectedValue(new Error("login refused"));

        await expect(connectWith(refused)).rejects.toThrow("login refused");

        expect(mark).not.toHaveBeenCalled();
    });

    it("leaves the connection made since, and its login marker, alone when a dropped one closes", async () => {
        jest.spyOn(service(), "getSettings").mockResolvedValue({ mode: "p2p", enabled: true, username: "u", password: "p" });
        const clear = jest.spyOn(soulseekLogin, "clear").mockResolvedValue(undefined);
        const first = fakeClient();
        const second = fakeClient();
        await connectWith(first);
        // A reset drops the first connection and connects again at once; the first one's close arrives afterwards.
        service().client = null;
        await connectWith(second);
        clear.mockClear();

        first.server.conn.emit("close");

        expect(service().client).toBe(second);
        expect(second.destroy).not.toHaveBeenCalled();
        expect(clear).not.toHaveBeenCalled();
    });

    it("drops the connection and removes the marker when the current connection closes", async () => {
        jest.spyOn(service(), "getSettings").mockResolvedValue({ mode: "p2p", enabled: true, username: "u", password: "p" });
        const clear = jest.spyOn(soulseekLogin, "clear").mockResolvedValue(undefined);
        const only = fakeClient();
        await connectWith(only);

        only.server.conn.emit("close");

        expect(service().client).toBeNull();
        expect(clear).toHaveBeenCalledTimes(1);
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
