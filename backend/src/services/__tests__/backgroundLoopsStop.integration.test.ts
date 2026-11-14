/**
 * The catch-up work after start-up (artist counts, image backfill, cache warmup, audiobook sync) stops quietly between
 * its batches once the server is shutting down, so none of it touches Prisma after the database has closed.
 * Each takes a `shouldStop` check. Real database; Redis and the image download are the only things replaced.
 */

jest.mock("../imageStorage", () => ({
    ...jest.requireActual("../imageStorage"),
    downloadAndStoreImage: jest.fn(async () => null),
}));

import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { backfillAllArtistCounts } from "../artistCountsService";
import { backfillAllImages, getImageBackfillProgress } from "../imageBackfill";
import { downloadAndStoreImage } from "../imageStorage";
import { dataCacheService } from "../dataCache";
import { audiobookCacheService } from "../audiobookCache";
import { audiobookshelfService } from "../audiobookshelf";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

jest.setTimeout(60_000);

const P = "zz-bgstop";
const download = downloadAndStoreImage as jest.Mock;

async function clean() {
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
    await clean();
    jest.restoreAllMocks();
});

afterAll(async () => {
    await clean();
    await closeEngineConnections();
});

async function seedArtists(count: number, heroUrl: string | null = null) {
    for (let i = 0; i < count; i++) {
        const id = `${P}-ar-${String(i).padStart(3, "0")}`;
        await prisma.artist.create({ data: { id, name: id, normalizedName: id, identityKey: id, heroUrl } });
    }
}

describe("backfillAllArtistCounts", () => {
    it("does not start a batch once told to stop, and answers what it counted", async () => {
        await seedArtists(3);
        const findMany = jest.spyOn(prisma.artist, "findMany");

        const answer = await backfillAllArtistCounts(undefined, { shouldStop: () => true });

        expect(answer).toEqual({ processed: 0, errors: 0 });
        expect(findMany).not.toHaveBeenCalled();
    });

    it("stops between batches: the batch under way finishes, the next is not read", async () => {
        await seedArtists(3);
        const findMany = jest.spyOn(prisma.artist, "findMany");
        let stop = false;

        const answer = await backfillAllArtistCounts(() => void (stop = true), { shouldStop: () => stop });

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(answer.processed).toBeGreaterThanOrEqual(3);
    });

    it("does not run the extra pass a recount asked for while it ran, once stopped", async () => {
        await seedArtists(1);
        const findMany = jest.spyOn(prisma.artist, "findMany");
        let stop = false;

        const running = backfillAllArtistCounts(
            () => {
                // The first batch is done: a recount is asked for, and the server begins to shut down.
                void backfillAllArtistCounts();
                stop = true;
            },
            { shouldStop: () => stop },
        );
        await running;

        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("runs to the end when never told to stop", async () => {
        await seedArtists(3);
        const findMany = jest.spyOn(prisma.artist, "findMany");

        await backfillAllArtistCounts(undefined, { shouldStop: () => false });

        // the batch, then the empty one that ends the pass
        expect(findMany).toHaveBeenCalledTimes(2);
    });
});

describe("backfillAllImages", () => {
    it("downloads nothing once told to stop", async () => {
        await seedArtists(3, "http://example.invalid/a.jpg");

        await backfillAllImages({ shouldStop: () => true });

        expect(download).not.toHaveBeenCalled();
    });

    it("stops between batches of ten: the batch under way finishes, the next is not started", async () => {
        await seedArtists(12, "http://example.invalid/a.jpg");
        let stop = false;
        download.mockImplementation(async () => {
            stop = true;
            return null;
        });

        await backfillAllImages({ shouldStop: () => stop });

        const ours = download.mock.calls.filter(([, id]) => String(id).startsWith(P));
        expect(download).toHaveBeenCalledTimes(10);
        expect(ours.length).toBeLessThanOrEqual(10);
    });

    it("leaves the albums alone when told to stop after the artists", async () => {
        await seedArtists(1, "http://example.invalid/a.jpg");
        const albumFind = jest.spyOn(prisma.album, "findMany");
        let stop = false;
        download.mockImplementation(async () => {
            stop = true;
            return null;
        });

        await backfillAllImages({ shouldStop: () => stop });

        expect(albumFind).not.toHaveBeenCalled();
    });

    it("downloads everything when never told to stop", async () => {
        await seedArtists(12, "http://example.invalid/a.jpg");

        await backfillAllImages({ shouldStop: () => false });

        expect(download.mock.calls.filter(([, id]) => String(id).startsWith(P))).toHaveLength(12);
    });

    it("lets one run at a time: a second call in the same tick does nothing", async () => {
        await seedArtists(2, "http://example.invalid/a.jpg");

        await Promise.all([backfillAllImages(), backfillAllImages()]);

        // Both artists once, not twice: the second call found the first running and went away.
        expect(download.mock.calls.filter(([, id]) => String(id).startsWith(P))).toHaveLength(2);
    });

    it("lets a later call run once the first has ended, and after one that failed", async () => {
        await seedArtists(1, "http://example.invalid/a.jpg");
        jest.spyOn(prisma.artist, "findMany").mockRejectedValueOnce(new Error("database down"));

        await expect(backfillAllImages()).rejects.toThrow("database down");
        await backfillAllImages();

        expect(download.mock.calls.filter(([, id]) => String(id).startsWith(P))).toHaveLength(1);
        expect(getImageBackfillProgress().inProgress).toBe(false);
    });

    it("reports itself in progress from the moment it is called", async () => {
        const running = backfillAllImages();
        expect(getImageBackfillProgress().inProgress).toBe(true);
        await running;
        expect(getImageBackfillProgress().inProgress).toBe(false);
    });
});

describe("dataCacheService.warmupCache", () => {
    it("reads and writes nothing once told to stop", async () => {
        await seedArtists(1, "http://example.invalid/a.jpg");
        const artistFind = jest.spyOn(prisma.artist, "findMany");
        const albumFind = jest.spyOn(prisma.album, "findMany");
        const multi = jest.spyOn(redisClient, "multi");

        await dataCacheService.warmupCache({ shouldStop: () => true });

        expect(artistFind).not.toHaveBeenCalled();
        expect(albumFind).not.toHaveBeenCalled();
        expect(multi).not.toHaveBeenCalled();
    });

    it("leaves the albums unread when told to stop after the artists", async () => {
        await seedArtists(1, "http://example.invalid/a.jpg");
        const albumFind = jest.spyOn(prisma.album, "findMany");
        let checks = 0;

        // Asked before the artists (no), then before the albums (yes).
        await dataCacheService.warmupCache({ shouldStop: () => ++checks > 1 });

        expect(albumFind).not.toHaveBeenCalled();
    });

    it("reads the artists a page at a time, by id, and stops between pages", async () => {
        // One more than a page, so the second page exists. The warmup writes to Redis once per page.
        await prisma.artist.createMany({
            data: Array.from({ length: 501 }, (_, i) => {
                const id = `${P}-wu-${String(i).padStart(3, "0")}`;
                return { id, name: id, normalizedName: id, identityKey: id, heroUrl: "http://example.invalid/a.jpg" };
            }),
        });
        const artistFind = jest.spyOn(prisma.artist, "findMany");
        const albumFind = jest.spyOn(prisma.album, "findMany");
        const write = jest.spyOn(redisClient, "multi");

        await dataCacheService.warmupCache({ shouldStop: () => write.mock.calls.length >= 1 });

        expect(artistFind).toHaveBeenCalledTimes(1);
        expect(artistFind.mock.calls[0][0]).toMatchObject({ take: 500, orderBy: { id: "asc" } });
        expect(albumFind).not.toHaveBeenCalled();
    });

    it("walks every page when never told to stop, each after the last id of the one before", async () => {
        await prisma.artist.createMany({
            data: Array.from({ length: 501 }, (_, i) => {
                const id = `${P}-wu-${String(i).padStart(3, "0")}`;
                return { id, name: id, normalizedName: id, identityKey: id, heroUrl: "http://example.invalid/a.jpg" };
            }),
        });
        const artistFind = jest.spyOn(prisma.artist, "findMany");

        await dataCacheService.warmupCache();

        const pages = artistFind.mock.calls.map(([args]) => args as { where?: { id?: { gt?: string } } });
        expect(pages.length).toBeGreaterThanOrEqual(2);
        expect(pages[0].where?.id).toBeUndefined();
        expect(pages[1].where?.id?.gt).toEqual(expect.any(String));
    });

    it("warms both when never told to stop", async () => {
        const albumFind = jest.spyOn(prisma.album, "findMany");

        await dataCacheService.warmupCache({ shouldStop: () => false });
        await dataCacheService.warmupCache();

        expect(albumFind).toHaveBeenCalled();
    });
});

describe("audiobookCacheService.syncAll", () => {
    const books = [{ id: `${P}-b1` }, { id: `${P}-b2` }, { id: `${P}-b3` }];

    it("stops between books and does not prune on a list it did not finish", async () => {
        jest.spyOn(audiobookshelfService, "getAllAudiobooks").mockResolvedValue(books as never);
        const syncOne = jest.spyOn(audiobookCacheService as never, "syncAudiobook" as never).mockResolvedValue(true as never);
        const prune = jest.spyOn(prisma.audiobook, "deleteMany");
        let stop = false;
        syncOne.mockImplementation((async () => {
            stop = true;
            return true;
        }) as never);

        const result = await audiobookCacheService.syncAll({ shouldStop: () => stop });

        expect(syncOne).toHaveBeenCalledTimes(1);
        expect(result.synced).toBe(1);
        expect(prune).not.toHaveBeenCalled();
    });

    it("does not prune when a book failed to sync: the list was not gone through", async () => {
        expectLog("error");
        expectLog("warn");
        jest.spyOn(audiobookshelfService, "getAllAudiobooks").mockResolvedValue(books as never);
        const syncOne = jest.spyOn(audiobookCacheService as never, "syncAudiobook" as never).mockResolvedValue(true as never);
        syncOne.mockRejectedValueOnce(new Error("cover download failed") as never);
        const prune = jest.spyOn(prisma.audiobook, "deleteMany");

        const result = await audiobookCacheService.syncAll();

        expect(result).toMatchObject({ synced: 2, failed: 1 });
        expect(result.pruned).toBe(0);
        expect(prune).not.toHaveBeenCalled();
    });

    it("syncs and prunes as before when never told to stop", async () => {
        jest.spyOn(audiobookshelfService, "getAllAudiobooks").mockResolvedValue(books as never);
        const syncOne = jest.spyOn(audiobookCacheService as never, "syncAudiobook" as never).mockResolvedValue(true as never);
        const prune = jest.spyOn(prisma.audiobook, "deleteMany").mockResolvedValue({ count: 0 } as never);

        const result = await audiobookCacheService.syncAll({ shouldStop: () => false });

        expect(syncOne).toHaveBeenCalledTimes(3);
        expect(result.synced).toBe(3);
        expect(prune).toHaveBeenCalledTimes(1);
    });
});
