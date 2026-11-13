/**
 * A Discover Weekly batch whose downloads have all finished moves to the scan
 * step in one transaction: every failed album is recorded as unavailable (an
 * album already recorded this week counts one more attempt), a job with no
 * album id is passed over, and the batch carries the final counts. Real database.
 */

import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const USER = "discover_completion_user";
const WEEK = new Date("2026-10-05T00:00:00.000Z");
const ALBUMS = {
    gwam: { mbid: "d0484284-1ee7-4157-951a-50f003cbcfb4", title: "Guess Who’s a Mess" },
    idk: { mbid: "10e85e9b-0f07-33d4-a927-18a273f86eca", title: "I Don't Know What I'm Doing" },
};

let discoverWeeklyService: typeof import("../discoverWeekly").discoverWeeklyService;

beforeAll(async () => {
    ({ discoverWeeklyService } = await import("../discoverWeekly"));
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const job = (batchId: string, status: string, album?: { mbid: string; title: string }) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, discoveryBatchId: batchId, type: "album", status,
            subject: `Brad Sucks - ${album?.title ?? "an album with no id"}`, targetMbid: album?.mbid ?? null,
            metadata: { artistName: "Brad Sucks", albumTitle: album?.title ?? "an album with no id", similarity: 0.8, tier: "medium" },
        },
    });

it("records each failed album once, skips a job with no album id, and moves the batch to the scan step", async () => {
    const batch = await prisma.discoveryBatch.create({
        data: { userId: USER, weekStart: WEEK, targetSongCount: 3, totalAlbums: 3, status: "downloading" },
    });
    await prisma.unavailableAlbum.create({
        data: {
            userId: USER, weekStartDate: WEEK, albumMbid: ALBUMS.idk.mbid, artistName: "Brad Sucks",
            albumTitle: ALBUMS.idk.title, similarity: 0.8, tier: "medium", attemptNumber: 1,
        },
    });
    await job(batch.id, "completed", ALBUMS.gwam);
    await job(batch.id, "failed", ALBUMS.idk);
    await job(batch.id, "failed");

    await discoverWeeklyService.checkBatchCompletion(batch.id);

    expect(await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
        status: "scanning", completedAlbums: 1, failedAlbums: 2,
    });
    const unavailable = await prisma.unavailableAlbum.findMany({ where: { userId: USER, weekStartDate: WEEK } });
    expect(unavailable.map((u) => [u.albumMbid, u.attemptNumber])).toEqual([[ALBUMS.idk.mbid, 2]]);
});

describe("a job the user cancelled", () => {
    const cancelled = async (batchId: string, album: { mbid: string; title: string }) => {
        const j = await job(batchId, "failed", album);
        return prisma.downloadJob.update({
            where: { id: j.id },
            data: { error: "Cancelled by user", metadata: { ...(j.metadata as object), cancelled: true } },
        });
    };
    const batchOf = (week: string, total: number) =>
        prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date(week), targetSongCount: total, totalAlbums: total, status: "downloading" },
        });
    const unavailable = (week: string) =>
        prisma.unavailableAlbum.findMany({ where: { userId: USER, weekStartDate: new Date(week) } });

    it("is never recorded as an unavailable album, and is not counted as a failure", async () => {
        const week = "2026-10-12T00:00:00.000Z";
        const batch = await batchOf(week, 2);
        await job(batch.id, "completed", ALBUMS.gwam);
        await cancelled(batch.id, ALBUMS.idk);

        await discoverWeeklyService.checkBatchCompletion(batch.id);

        expect(await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
            status: "scanning", completedAlbums: 1, failedAlbums: 0,
        });
        expect(await unavailable(week)).toEqual([]);
    });

    it("leaves a batch with one real failure and one cancel as 'all downloads failed', recording only the failure", async () => {
        const week = "2026-10-19T00:00:00.000Z";
        const batch = await batchOf(week, 2);
        await job(batch.id, "failed", ALBUMS.gwam);
        await cancelled(batch.id, ALBUMS.idk);

        await discoverWeeklyService.checkBatchCompletion(batch.id);

        expect(await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
            status: "failed", completedAlbums: 0, failedAlbums: 1, errorMessage: "All downloads failed",
        });
        expect((await unavailable(week)).map((u) => u.albumMbid)).toEqual([ALBUMS.gwam.mbid]);
    });

    it("ends a batch of only cancelled jobs as cancelled, not as 'all downloads failed'", async () => {
        const week = "2026-10-26T00:00:00.000Z";
        const batch = await batchOf(week, 1);
        await cancelled(batch.id, ALBUMS.gwam);

        await discoverWeeklyService.checkBatchCompletion(batch.id);

        const row = await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } });
        expect(row).toMatchObject({ status: "failed", failedAlbums: 0 });
        expect(row.errorMessage).toBe("All downloads cancelled");
        expect(await unavailable(week)).toEqual([]);
    });
});
