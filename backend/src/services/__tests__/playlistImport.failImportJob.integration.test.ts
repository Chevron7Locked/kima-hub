/**
 * An import is failed from outside the import (the stuck-work check, the stale-job cleanup) through one move: it only
 * leaves a state that is not final, and it tells the person's open import page, so the page stops spinning. Real
 * database and Redis.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { eventBus, type SSEEvent } from "../eventBus";
import { failImportJob, getImportJob } from "../playlistImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "zz-fail-import-user";

const job = (status: string) =>
    prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status, progress: 80, albumsTotal: 1, tracksTotal: 1, pendingTracks: [],
        },
    });

let heard: SSEEvent[];
let stop: () => void;

beforeAll(async () => {
    await waitForRedisReady();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(() => {
    heard = [];
    stop = eventBus.subscribe(USER, { send: (event) => (heard.push(event), true) });
});

afterEach(async () => {
    stop();
    const ids = (await prisma.spotifyImportJob.findMany({ where: { userId: USER }, select: { id: true } })).map((j) => j.id);
    await Promise.all(ids.map((id) => redisClient.del(`import:job:${id}`)));
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("fails an import that is still running, and tells the page and the cache", async () => {
    const running = await job("scanning");

    expect(await failImportJob(running.id, "Scan timed out after 30 minutes")).toBe(true);

    expect(await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
        status: "failed",
        error: "Scan timed out after 30 minutes",
    });
    expect(heard).toEqual([
        expect.objectContaining({
            type: "import:progress",
            payload: expect.objectContaining({ jobId: running.id, status: "failed", error: "Scan timed out after 30 minutes" }),
        }),
    ]);
    expect((await getImportJob(running.id))?.status).toBe("failed");
});

it.each(["completed", "failed", "cancelled"])("leaves an import that is already %s, and tells nobody", async (status) => {
    const closed = await job(status);
    await prisma.spotifyImportJob.update({ where: { id: closed.id }, data: { error: status === "failed" ? "first reason" : null } });

    expect(await failImportJob(closed.id, "late reason")).toBe(false);

    const row = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.status).toBe(status);
    expect(row.error).toBe(status === "failed" ? "first reason" : null);
    expect(heard).toEqual([]);
});

it("answers false for an import that is gone", async () => {
    expect(await failImportJob("import_gone", "x")).toBe(false);
    expect(heard).toEqual([]);
});
