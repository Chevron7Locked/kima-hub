/**
 * The queue length limit is read through the system settings (cached, with the one clamp), and a read that fails
 * falls back to the default but says so in the log, as a warning.
 */
const getSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    QUEUE_LENGTH: { min: 100, max: 100000, default: 10000 },
    getSystemSettings: (...args: unknown[]) => getSystemSettings(...args),
}));
jest.mock("../../utils/db", () => ({ prisma: {}, Prisma: {} }));
jest.mock("../../utils/logger", () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { logger } from "../../utils/logger";
import { queueLimit } from "../savedQueue";

beforeEach(() => jest.clearAllMocks());

describe("queueLimit", () => {
    it("is the operator's saved limit, as the settings read answers it", async () => {
        getSystemSettings.mockResolvedValue({ maxQueueLength: 2500 });

        expect(await queueLimit()).toBe(2500);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each([
        ["no settings saved yet", null, 10000],
        ["a limit of zero", { maxQueueLength: 0 }, 10000],
        ["a limit below the least", { maxQueueLength: 5 }, 100],
        ["a limit above the most", { maxQueueLength: 9_999_999 }, 100000],
        ["a fractional limit", { maxQueueLength: 250.7 }, 250],
    ])("answers the default or the nearest allowed value for %s", async (_why, settings, expected) => {
        getSystemSettings.mockResolvedValue(settings);

        expect(await queueLimit()).toBe(expected);
    });

    it("falls back to the default when the read fails, and logs a warning that names the failure", async () => {
        const failure = new Error("settings store is down");
        getSystemSettings.mockRejectedValue(failure);

        expect(await queueLimit()).toBe(10000);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect((logger.warn as jest.Mock).mock.calls[0]).toContain(failure);
    });
});
