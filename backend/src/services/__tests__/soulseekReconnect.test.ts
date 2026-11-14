/**
 * Soulseek's reset-and-reconnect runs one at a time, and a caller that saved settings can wait for the one in
 * flight (`reconnectSettled`) without starting another. The connection itself is stood in for.
 */
import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

let before: Record<string, unknown> | null;
let soulseekService: typeof import("../soulseek").soulseekService;
let connect: jest.SpyInstance;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    // Soulseek starts connecting as it loads when it is enabled; it is not.
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", soulseekEnabled: false }, update: { soulseekEnabled: false } });
    invalidateSystemSettingsCache();
    ({ soulseekService } = await import("../soulseek"));
    connect = jest.spyOn(soulseekService as any, "ensureConnected");
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    soulseekService.disconnect();
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

beforeEach(() => connect.mockReset());

it("waiting for a reconnect that is not running answers at once", async () => {
    await expect(soulseekService.reconnectSettled()).resolves.toBeUndefined();
});

it("waits for the reconnect in flight, and does not throw when it fails", async () => {
    let finish!: () => void;
    connect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let settled = false;

    const reconnecting = soulseekService.resetAndReconnect();
    const waiting = soulseekService.reconnectSettled().then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    finish();
    await reconnecting;
    await waiting;
    expect(settled).toBe(true);

    connect.mockRejectedValueOnce(new Error("soulseek is down"));
    const failing = soulseekService.resetAndReconnect();
    failing.catch(() => {});
    await expect(soulseekService.reconnectSettled()).resolves.toBeUndefined();
    await expect(failing).rejects.toThrow("soulseek is down");
});

it("runs two reconnects one after the other, never side by side", async () => {
    const order: string[] = [];
    let release!: () => void;
    connect.mockImplementationOnce(async () => {
        order.push("first starts");
        await new Promise<void>((resolve) => { release = resolve; });
        order.push("first ends");
    });
    connect.mockImplementationOnce(async () => {
        order.push("second starts");
    });

    const first = soulseekService.resetAndReconnect();
    const second = soulseekService.resetAndReconnect();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first starts"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first starts", "first ends", "second starts"]);
});
