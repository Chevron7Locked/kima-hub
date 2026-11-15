/**
 * The queue length limit is read through the system settings (cached, with the one clamp), and a read that fails
 * falls back to the default but says so in the log, as a warning. The limit is saved into the suite database through
 * saveSystemSettings, as an operator's save is.
 */
import { prisma } from "../../utils/db";
import * as systemSettings from "../../utils/systemSettings";
import { saveSystemSettings, invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { queueLimit } from "../savedQueue";

// The whole row as it was, so the case that deletes it can put every column back.
let before: Awaited<ReturnType<typeof prisma.systemSettings.findUnique>> = null;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
});

afterEach(() => {
    jest.restoreAllMocks();
    invalidateSystemSettingsCache();
});

afterAll(async () => {
    if (before) await prisma.systemSettings.upsert({ where: { id: "default" }, create: before, update: before });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
});

describe("queueLimit", () => {
    it("is the operator's saved limit", async () => {
        await saveSystemSettings({ maxQueueLength: 2500 });
        const logged = expectLog("warn");

        expect(await queueLimit()).toBe(2500);
        expect(logged).not.toHaveBeenCalled();
    });

    it.each([
        ["a limit of zero", 0, 10000],
        ["a limit below the least", 5, 100],
        ["a limit above the most", 9_999_999, 100000],
    ])("answers the default or the nearest allowed value for %s", async (_why, saved, expected) => {
        await saveSystemSettings({ maxQueueLength: saved });

        expect(await queueLimit()).toBe(expected);
    });

    it("answers the default when no settings are saved yet", async () => {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        invalidateSystemSettingsCache();

        expect(await queueLimit()).toBe(10000);
    });

    it("rounds a fractional limit down", async () => {
        // The column holds whole numbers, so a fraction can only come from the settings read itself.
        jest.spyOn(systemSettings, "getSystemSettings").mockResolvedValue({ maxQueueLength: 250.7 } as never);

        expect(await queueLimit()).toBe(250);
    });

    it("falls back to the default when the read fails, and logs a warning that names the failure", async () => {
        const failure = new Error("settings store is down");
        jest.spyOn(systemSettings, "getSystemSettings").mockRejectedValue(failure);
        const logged = expectLog("warn");

        expect(await queueLimit()).toBe(10000);
        expect(logged).toHaveBeenCalledTimes(1);
        expect(logged.mock.calls[0]).toContain(failure);
    });
});
