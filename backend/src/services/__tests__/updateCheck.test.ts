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
import { invalidateSystemSettingsCache, onSystemSettingsChange } from "../../utils/systemSettings";

const HOUR = 60 * 60 * 1000;

// The one shared settings row belongs to every suite, so this one touches only the three fields the check reads and
// writes: it starts each test from their defaults and puts back what it found.
const FIELDS = { updateChecksEnabled: true, lastUpdateCheck: null, latestKnownVersion: null } as const;
type Fields = { updateChecksEnabled: boolean; lastUpdateCheck: Date | null; latestKnownVersion: string | null };
async function setFields(fields: Partial<Fields>) {
    const data = { ...FIELDS, ...fields };
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    invalidateSystemSettingsCache();
}

/** Settings as a previous check left them. */
const checkedBefore = (latestKnownVersion: string, hoursAgo: number) =>
    setFields({ latestKnownVersion, lastUpdateCheck: new Date(Date.now() - hoursAgo * HOUR) });

const get = mocked(axios.get);
let found: Fields | null = null;

beforeAll(async () => {
    const row = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    found = row && { updateChecksEnabled: row.updateChecksEnabled, lastUpdateCheck: row.lastUpdateCheck, latestKnownVersion: row.latestKnownVersion };
});

beforeEach(async () => {
    jest.clearAllMocks();
    await setFields({});
});

afterAll(async () => {
    await setFields(found ?? {});
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
        await checkedBefore("99.0.0", 48);
        get.mockRejectedValue(new Error("offline"));

        const status = await getUpdateStatus();

        expect(get).toHaveBeenCalledTimes(1);
        expect(status).toMatchObject({ latest: "99.0.0", hasUpdate: true });
        expect(new Date(status.lastCheckedAt!).getTime()).toBeGreaterThan(Date.now() - HOUR);
    });

    it("asks again once a day has passed since the last check", async () => {
        await checkedBefore("1.0.0", 25);
        get.mockResolvedValue({ status: 200, data: { tag_name: "v99.0.0" } });

        const status = await getUpdateStatus();

        expect(get).toHaveBeenCalledTimes(1);
        expect(status.latest).toBe("99.0.0");
    });

    it("shares one request between callers that arrive while it runs", async () => {
        await checkedBefore("1.0.0", 25);
        let answer!: (v: unknown) => void;
        get.mockReturnValue(new Promise((r) => (answer = r)) as never);

        const both = Promise.all([getUpdateStatus(), getUpdateStatus()]);
        await new Promise((r) => setTimeout(r, 50));
        answer({ status: 200, data: { tag_name: "v99.0.0" } });
        const [a, b] = await both;

        expect(get).toHaveBeenCalledTimes(1);
        expect(a.latest).toBe("99.0.0");
        expect(b.latest).toBe("99.0.0");
    });

    it("answers disabled without any network call", async () => {
        await setFields({ updateChecksEnabled: false });

        const status = await getUpdateStatus({ force: true });

        expect(status).toMatchObject({ enabled: false, hasUpdate: false, latest: null });
        expect(get).not.toHaveBeenCalled();
    });
});

describe("the check's own record", () => {
    it("is saved through the settings save, so whoever reads it is told what changed", async () => {
        const heard = jest.fn();
        const signOff = onSystemSettingsChange("test listener", ["lastUpdateCheck", "latestKnownVersion"], heard);
        try {
            get.mockResolvedValue({ status: 200, data: { tag_name: "v99.0.0" } });
            await getUpdateStatus({ force: true });
            expect(heard.mock.calls[0][0].sort()).toEqual(["lastUpdateCheck", "latestKnownVersion"]);
        } finally {
            signOff();
        }
    });
});
