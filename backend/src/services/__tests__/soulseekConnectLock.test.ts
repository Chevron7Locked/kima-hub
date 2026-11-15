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
import { LockHeldError, LockUnavailableError } from "../../utils/lockErrors";

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

it("fails at once with the lock's reason when Redis is down", async () => {
    jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockUnavailableError("soulseek:connection"));

    await expect(ensureConnected()).rejects.toBeInstanceOf(LockUnavailableError);
});
