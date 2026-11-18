/**
 * One Discover clear per person at a time, an unlike never runs during one, and a clear that fails says why. Real test database and Redis; Lidarr is off.
 */

jest.mock("../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: "dturn_user", role: "admin" };
        next();
    };
    return { requireAuthOrToken: signIn, requireAuth: signIn, requireAdmin: signIn, requireAcquirePermission: signIn };
});
jest.mock("../../workers/scanRequest", () => ({
    requestScan: jest.fn().mockResolvedValue({ queued: true, jobId: "test-scan" }),
}));
jest.mock("../../workers/queues", () => ({
    discoverQueue: { getJob: jest.fn(), add: jest.fn(), getActive: jest.fn().mockResolvedValue([]), getWaiting: jest.fn().mockResolvedValue([]) },
    scanQueue: { add: jest.fn().mockResolvedValue({ id: "test-scan" }) },
    discoverArtistsQueue: { getJobs: jest.fn().mockResolvedValue([]), add: jest.fn().mockResolvedValue({ id: "test-artists" }) },
}));

import request from "supertest";
import { prisma } from "../../utils/db";
import { distributedLock } from "../../utils/distributedLock";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { useNoLidarr } from "../../__tests__/helpers/lidarrSettings";
import { discoveryAlbumLifecycle } from "../../services/discovery/discoveryAlbumLifecycle";
import { clearTurnKey } from "../../services/discovery/discoveryAlbumLifecycle";
import { discoverApp } from "./helpers/discoverClear";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

jest.setTimeout(60_000);

const USER = "dturn_user";

beforeAll(async () => {
    await useNoLidarr();
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x", role: "admin" }, update: {} });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

afterEach(() => {
    jest.restoreAllMocks();
});

it("answers 409 while another clear of the same person's Discover is running, and runs once it is done", async () => {
    const held = await distributedLock.acquire(clearTurnKey(USER), 30_000);
    if (held.outcome !== "acquired") throw new Error("test could not take the clear turn");
    try {
        const busy = await request(discoverApp()).delete("/discover/clear");
        expect(busy.status).toBe(409);
        expect(busy.body.error).toBe("a clear of your discover is already running");
    } finally {
        await held.lease.release();
    }

    const free = await request(discoverApp()).delete("/discover/clear");
    expect(free.status).toBe(200);
});

it("lets the clear go: a second clear can start once the first answered", async () => {
    expect((await request(discoverApp()).delete("/discover/clear")).status).toBe(200);
    expect((await request(discoverApp()).delete("/discover/clear")).status).toBe(200);
    expect(await distributedLock.isHeld(clearTurnKey(USER))).toBe(false);
});

it("a failed clear says it stopped and leaves the server's own error text in the log", async () => {
    const errors = expectLog("error");
    jest.spyOn(prisma.discoveryAlbum, "findMany").mockRejectedValueOnce(new Error("the database went away"));
    const res = await request(discoverApp()).delete("/discover/clear");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("the clear stopped: a server error; the server log has the reason");
    expect(errors).toHaveBeenCalledWith("Clear discovery playlist error:", expect.objectContaining({ message: "the database went away" }));
});

it("the weekly clear waits for a running clear instead of failing", async () => {
    const held = await distributedLock.acquire(clearTurnKey(USER), 30_000);
    if (held.outcome !== "acquired") throw new Error("test could not take the clear turn");
    const weekly = discoveryAlbumLifecycle.clearDiscover(USER, { waitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    await held.lease.release();
    await expect(weekly).resolves.toMatchObject({ deleted: 0 });
});

it("an unlike during a clear answers 409 and leaves the like as it was", async () => {
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.discoveryAlbum.create({
        data: { userId: USER, rgMbid: "dturn-rg", artistName: "dturn band", albumTitle: "dturn lp", weekStartDate: new Date("2026-11-02"), status: "LIKED", likedAt: new Date() },
    });
    const held = await distributedLock.acquire(clearTurnKey(USER), 30_000);
    if (held.outcome !== "acquired") throw new Error("test could not take the clear turn");
    try {
        const busy = await request(discoverApp()).delete("/discover/unlike").send({ albumId: "dturn-rg" });
        expect(busy.status).toBe(409);
        expect(busy.body.error).toBe("a clear of your discover is running; try again when it is done");
        expect((await prisma.discoveryAlbum.findFirstOrThrow({ where: { userId: USER, rgMbid: "dturn-rg" } })).status).toBe("LIKED");
    } finally {
        await held.lease.release();
    }

    expect((await request(discoverApp()).delete("/discover/unlike").send({ albumId: "dturn-rg" })).status).toBe(200);
    expect((await prisma.discoveryAlbum.findFirstOrThrow({ where: { userId: USER, rgMbid: "dturn-rg" } })).status).toBe("ACTIVE");
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
});
