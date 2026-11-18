/**
 * The run that removes Discover's artists from Lidarr after a clear, against the real test database. Lidarr is a mock:
 * each artist here has no files, so a removal is Lidarr forgetting it. What Lidarr refuses goes to every admin's tray
 * as one row, and a run with no refusal clears that row.
 */

jest.mock("../../lidarr", () => ({
    lidarrService: {
        readDiscoveryTaggedArtists: jest.fn(),
        getOrCreateDiscoveryTag: jest.fn(),
        getAlbumsByArtistId: jest.fn(),
        deleteArtistById: jest.fn(),
        removeDiscoveryTagByMbid: jest.fn(),
    },
}));
jest.mock("../../../workers/queues", () => ({
    discoverArtistsQueue: { getJobs: jest.fn(), add: jest.fn() },
}));

import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import { discoverArtistsQueue } from "../../../workers/queues";
import {
    discoverArtistsGroupKey,
    previewDiscoverArtists,
    requestDiscoverArtistCleanup,
    runDiscoverArtistCleanup,
    takeDiscoverArtistsTurn,
} from "../discoverArtistCleanup";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const ADMIN = "dac_admin";
const TAG = 22;
const lidarr = lidarrService as jest.Mocked<typeof lidarrService>;
const queue = discoverArtistsQueue as unknown as { getJobs: jest.Mock; add: jest.Mock };

const artist = (id: number, artistName: string) => ({ id, artistName, foreignArtistId: `dac-mbid-${id}`, tags: [TAG] }) as any;
const trayRow = () => prisma.notification.findUnique({ where: { userId_groupKey: { userId: ADMIN, groupKey: discoverArtistsGroupKey } } });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.notification.deleteMany({ where: { groupKey: discoverArtistsGroupKey } });
    lidarr.getOrCreateDiscoveryTag.mockResolvedValue(TAG);
    lidarr.getAlbumsByArtistId.mockResolvedValue([{ id: 7, artistId: 1, title: "A", foreignAlbumId: "dac-rg", statistics: { trackFileCount: 0 } }] as any);
    lidarr.deleteArtistById.mockResolvedValue({ success: true, message: "Artist deleted" });
});

afterAll(async () => {
    await prisma.notification.deleteMany({ where: { groupKey: discoverArtistsGroupKey } });
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("runDiscoverArtistCleanup", () => {
    it("removes every artist nothing keeps and clears an earlier tray row", async () => {
        await prisma.notification.create({
            data: { userId: ADMIN, groupKey: discoverArtistsGroupKey, type: "error", title: "1 Discover artist not removed from Lidarr" },
        });
        lidarr.readDiscoveryTaggedArtists.mockResolvedValue([artist(1, "Interpol"), artist(2, "Low")]);

        expect(await runDiscoverArtistCleanup()).toEqual({ removed: 2, kept: 0, failed: [] });
        expect(lidarr.deleteArtistById).toHaveBeenCalledTimes(2);
        expect(await trayRow()).toBeNull();
    });

    it("names each artist Lidarr refused, with Lidarr's reason, in one admin tray row, and goes on to the rest", async () => {
        lidarr.readDiscoveryTaggedArtists.mockResolvedValue([artist(1, "Interpol"), artist(2, "Low"), artist(3, "Slint")]);
        lidarr.deleteArtistById.mockImplementation(async (id: number) =>
            id === 2 ? { success: false, message: "timeout of 30000ms exceeded" } : { success: true, message: "Artist deleted" },
        );

        const result = await runDiscoverArtistCleanup();

        expect(result).toEqual({ removed: 2, kept: 0, failed: [{ artistName: "Low", reason: "timeout of 30000ms exceeded" }] });
        const row = await trayRow();
        expect(row?.title).toBe("1 Discover artist not removed from Lidarr");
        expect(row?.message).toContain("Low: timeout of 30000ms exceeded");
    });

    it("reports a Lidarr it could not read, never taking that for no artists", async () => {
        lidarr.readDiscoveryTaggedArtists.mockRejectedValue(new Error("connect ECONNREFUSED"));

        const result = await runDiscoverArtistCleanup();

        expect(result.unread).toContain("connect ECONNREFUSED");
        expect(result.failed).toEqual([]);
        const row = await trayRow();
        expect(row?.title).toBe("Discover's artists not removed from Lidarr");
        expect(row?.message).toContain("connect ECONNREFUSED");
    });

    it("deletes nothing and clears an earlier tray row when Lidarr is not set up", async () => {
        await prisma.notification.create({
            data: { userId: ADMIN, groupKey: discoverArtistsGroupKey, type: "error", title: "1 Discover artist not removed from Lidarr" },
        });
        lidarr.readDiscoveryTaggedArtists.mockResolvedValue(null);

        expect(await runDiscoverArtistCleanup()).toEqual({ removed: 0, kept: 0, failed: [] });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(await trayRow()).toBeNull();
    });

    it("waits while a generation holds the artists turn, then runs", async () => {
        lidarr.readDiscoveryTaggedArtists.mockResolvedValue([artist(1, "Interpol")]);
        const generation = await takeDiscoverArtistsTurn();

        const run = runDiscoverArtistCleanup();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(lidarr.readDiscoveryTaggedArtists).not.toHaveBeenCalled();

        await generation.release();
        expect(await run).toEqual({ removed: 1, kept: 0, failed: [] });
    });
});

describe("previewDiscoverArtists", () => {
    it("names what a run would remove and keep, removing nothing and leaving the tray alone", async () => {
        await prisma.notification.create({
            data: { userId: ADMIN, groupKey: discoverArtistsGroupKey, type: "error", title: "1 Discover artist not removed from Lidarr" },
        });
        lidarr.readDiscoveryTaggedArtists.mockResolvedValue([artist(1, "Interpol"), { ...artist(2, "Untagged"), tags: [] }]);

        expect(await previewDiscoverArtists()).toEqual({
            removed: ["Interpol"],
            kept: ["Untagged (files Discover did not fetch, or Kima cannot tell)"],
            errors: [],
        });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(await trayRow()).not.toBeNull();
    });

    it("throws when Lidarr cannot be read, and is null when Lidarr is not set up", async () => {
        lidarr.readDiscoveryTaggedArtists.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
        await expect(previewDiscoverArtists()).rejects.toThrow("connect ECONNREFUSED");

        lidarr.readDiscoveryTaggedArtists.mockResolvedValueOnce(null);
        expect(await previewDiscoverArtists()).toBeNull();
    });
});

describe("requestDiscoverArtistCleanup", () => {
    it("queues a run", async () => {
        queue.getJobs.mockResolvedValue([]);
        await expect(requestDiscoverArtistCleanup()).resolves.toBeNull();
        expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it("adds nothing while a run is already waiting, since that run reads the artists afresh", async () => {
        queue.getJobs.mockResolvedValue([{ id: "waiting-run" }]);
        await requestDiscoverArtistCleanup();
        expect(queue.add).not.toHaveBeenCalled();
    });

    it("puts a run that could not be queued in the admin tray instead of failing the clear", async () => {
        queue.getJobs.mockRejectedValue(new Error("Connection is closed."));

        await expect(requestDiscoverArtistCleanup()).resolves.toBe("the removal could not be started: Connection is closed.");

        const row = await trayRow();
        expect(row?.title).toBe("Discover's artists not removed from Lidarr");
        expect(row?.message).toContain("could not be started: Connection is closed.");
    });
});
