/**
 * Update checks: version comparison math, the daily refresh cadence against
 * the real database, the disabled path, and silence on upstream failure.
 * Only the GitHub endpoint is stubbed; settings persist for real.
 */

jest.mock("axios", () => ({
    __esModule: true,
    default: { get: jest.fn() },
}));

import { mocked } from "jest-mock";
import axios from "axios";
import { prisma } from "../../utils/db";
import { compareVersions, getUpdateStatus } from "../updateCheck";

const get = mocked(axios.get);

beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.systemSettings.deleteMany({});
});

afterAll(async () => {
    await prisma.systemSettings.deleteMany({});
});

// The comparison the version chip rides on. GitHub's /releases/latest never returns a draft or a
// prerelease, so only published release tags reach it.
describe("compareVersions", () => {
    it.each([
        ["1.12.0", "1.11.0", 1],
        ["v1.12.0", "1.11.0", 1],
        ["1.11.0", "1.11.0", 0],
        ["1.12.0", "1.12.0", 0],
        ["v1.12.0", "1.12.0", 0],
        ["1.11.0", "1.12.0", -1],
        ["1.11.5", "1.12.0", -1],
        ["1.9.0", "1.10.0", -1],
        ["1.11.0.1", "1.11.0", 1],
        ["1.11", "1.11.0", 0],
    ])("%s vs %s -> %d", (a, b, expected) => {
        expect(Math.sign(compareVersions(a, b))).toBe(expected);
    });
});

describe("getUpdateStatus", () => {
    it("marks an update when the latest tag is newer", async () => {
        get.mockResolvedValue({ status: 200, data: { tag_name: "v99.0.0" } });

        const status = await getUpdateStatus({ force: true });

        expect(status).toMatchObject({ enabled: true, latest: "99.0.0", hasUpdate: true });
        expect(status.current).toMatch(/^\d+\.\d+\.\d+$/);

        const row = await prisma.systemSettings.findUnique({ where: { id: "default" } });
        expect(row?.latestKnownVersion).toBe("99.0.0");
        expect(row?.lastUpdateCheck).not.toBeNull();
    });

    it("does not mark an update when the latest tag is older or equal", async () => {
        get.mockResolvedValue({ status: 200, data: { tag_name: "v0.0.1" } });

        const status = await getUpdateStatus({ force: true });

        expect(status.hasUpdate).toBe(false);
        expect(status.latest).toBe("0.0.1");
    });

    it("uses the cached answer inside a day instead of calling out again", async () => {
        get.mockResolvedValue({ status: 200, data: { tag_name: "v99.0.0" } });
        await getUpdateStatus({ force: true });

        const cached = await getUpdateStatus();
        expect(get).toHaveBeenCalledTimes(1);
        expect(cached.hasUpdate).toBe(true);
    });

    it("stays quiet and keeps the previous version when GitHub cannot be reached", async () => {
        get.mockRejectedValue(new Error("offline"));

        const status = await getUpdateStatus({ force: true });

        expect(status.hasUpdate).toBe(false);
        expect(status.latest).toBeNull();
        expect(status.lastCheckedAt).not.toBeNull();
    });

    it("answers disabled without any network call", async () => {
        await prisma.systemSettings.create({
            data: { id: "default", updateChecksEnabled: false },
        });

        const status = await getUpdateStatus({ force: true });

        expect(status).toMatchObject({ enabled: false, hasUpdate: false, latest: null });
        expect(get).not.toHaveBeenCalled();
    });
});
