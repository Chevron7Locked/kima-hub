/**
 * The stale-job cleanup fails a Spotify import left in any active status past
 * two hours, including one that died while fetching the playlist, and leaves a
 * recent one alone. Real database.
 */
import { prisma } from "../../utils/db";
import { staleJobCleanupService } from "../staleJobCleanup";
import { eventBus, type SSEEvent } from "../eventBus";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const USER = "stale_cleanup_user";
const HOURS = 60 * 60 * 1000;
const ACTIVE = ["pending", "fetching", "downloading", "scanning", "creating_playlist"];

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const job = (status: string, ageMs: number) =>
    prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status, albumsTotal: 1, tracksTotal: 1, pendingTracks: [], createdAt: new Date(Date.now() - ageMs),
        },
    });

it("fails an import stuck in any active status, and keeps a recent one", async () => {
    const stuck = await Promise.all(ACTIVE.map((status) => job(status, 3 * HOURS)));
    const recent = await job("fetching", 10 * 60 * 1000);

    const result = await staleJobCleanupService.cleanupAll();

    expect(result.spotifyImportJobs.ids.sort()).toEqual(stuck.map((j) => j.id).sort());
    const rows = await prisma.spotifyImportJob.findMany({ where: { userId: USER } });
    for (const row of rows) expect(row.status).toBe(row.id === recent.id ? "fetching" : "failed");
});

it("tells the person's import page of each import it fails", async () => {
    const stuck = await job("downloading", 3 * HOURS);
    const heard: SSEEvent[] = [];
    const stop = eventBus.subscribe(USER, { send: (event) => (heard.push(event), true) });

    await staleJobCleanupService.cleanupAll();
    stop();

    expect(heard).toEqual(expect.arrayContaining([
        expect.objectContaining({
            type: "import:progress",
            payload: expect.objectContaining({ jobId: stuck.id, status: "failed", error: "Cleaned up as stale by user request" }),
        }),
    ]));
});
