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
    // restoreAllMocks leaves a jest.fn's implementation alone, so a download one test held open would hold the next.
    download.mockReset();
    download.mockResolvedValue(null);
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

    it("answers a second caller from the run in progress instead of with nothing, so whoever waits waits for the run", async () => {
        await seedArtists(3);

        const first = backfillAllArtistCounts();
        const second = backfillAllArtistCounts();
        const [ran, asked] = await Promise.all([first, second]);

        expect(asked).toEqual(ran);
        expect(asked.processed).toBeGreaterThanOrEqual(3);
    });

    it("keeps the second caller's ask: the running recount goes over the artists once more", async () => {
        await seedArtists(1);
        const findMany = jest.spyOn(prisma.artist, "findMany");

        const first = backfillAllArtistCounts();
        await new Promise((resolve) => setImmediate(resolve)); // the first pass is under way, waiting on the database
        const second = backfillAllArtistCounts();
        await Promise.all([first, second]);

        // two passes, each the batch and the empty one that ends it
        expect(findMany).toHaveBeenCalledTimes(4);
    });

    it("lets a later call run once the first has ended, and after one that failed", async () => {
        await seedArtists(1);
        jest.spyOn(prisma.artist, "count").mockRejectedValueOnce(new Error("database down"));

        await expect(backfillAllArtistCounts()).rejects.toThrow("database down");
        const answer = await backfillAllArtistCounts();

        expect(answer.processed).toBeGreaterThanOrEqual(1);
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

    it("ends the pause between batches at once when told to stop, instead of waiting it out", async () => {
        await seedArtists(12, "http://example.invalid/a.jpg");
        let stop = false;
        download.mockImplementation(async () => {
            stop = true;
            return null;
        });

        const started = Date.now();
        await backfillAllImages({ shouldStop: () => stop });

        expect(Date.now() - started).toBeLessThan(800);
    });

    it("hands each download a signal that aborts when told to stop, so one slow download cannot outlast the drain", async () => {
        await seedArtists(1, "http://example.invalid/a.jpg");
        let stop = false;
        let abortedBy: "signal" | "never" = "never";
        download.mockImplementation(async (_url: string, _id: string, _kind: string, signal?: AbortSignal) => {
            stop = true;
            // A download that would run for 30 s, ended only by the signal.
            await new Promise<void>((resolve) => {
                if (!signal) return resolve();
                signal.addEventListener("abort", () => {
                    abortedBy = "signal";
                    resolve();
                });
            });
            return null;
        });

        await backfillAllImages({ shouldStop: () => stop });

        expect(abortedBy).toBe("signal");
    });

    describe("on a library bigger than a page", () => {
        // The pause between batches is the real clock's second: a page of 500 is fifty of them, so the clock is driven.
        async function withClock<T>(run: () => Promise<T>): Promise<T> {
            jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "clearImmediate", "queueMicrotask"] });
            try {
                const running = run();
                let settled = false;
                running.then(
                    () => (settled = true),
                    () => (settled = true),
                );
                // Each step also yields a real turn, so the database replies the run waits on are not starved by the loop.
                while (!settled) {
                    await jest.advanceTimersByTimeAsync(1000);
                    await new Promise<void>((resolve) => setImmediate(resolve));
                }
                return await running;
            } finally {
                jest.useRealTimers();
            }
        }
        const seedPage = () =>
            prisma.artist.createMany({
                data: Array.from({ length: 501 }, (_, i) => {
                    const id = `${P}-pg-${String(i).padStart(3, "0")}`;
                    return { id, name: id, normalizedName: id, identityKey: id, heroUrl: "http://example.invalid/a.jpg" };
                }),
            });

        it("reads the artists 500 at a time, by id, and stops between pages", async () => {
            await seedPage();
            const artistFind = jest.spyOn(prisma.artist, "findMany");
            const albumFind = jest.spyOn(prisma.album, "findMany");

            await withClock(() => backfillAllImages({ shouldStop: () => download.mock.calls.length >= 500 }));

            expect(artistFind).toHaveBeenCalledTimes(1);
            expect(artistFind.mock.calls[0][0]).toMatchObject({ take: 500, orderBy: { id: "asc" } });
            expect(albumFind).not.toHaveBeenCalled();
        });

        it("walks every page when never told to stop, each after the last id of the one before", async () => {
            await seedPage();
            const artistFind = jest.spyOn(prisma.artist, "findMany");

            await withClock(() => backfillAllImages());

            const pages = artistFind.mock.calls.map(([args]) => args as { where?: { id?: { gt?: string } } });
            expect(pages.length).toBeGreaterThanOrEqual(2);
            expect(pages[0].where?.id).toBeUndefined();
            expect(pages[1].where?.id?.gt).toEqual(expect.any(String));
            expect(download.mock.calls.filter(([, id]) => String(id).startsWith(P))).toHaveLength(501);
        });
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
        await prisma.audiobook.create({ data: { id: `${P}-stale`, title: "Stale", sortName: "stale", audioUrl: `${P}-stale` } });
        jest.spyOn(audiobookshelfService, "getAllAudiobooks").mockResolvedValue(books as never);
        const syncOne = jest.spyOn(audiobookCacheService as never, "syncAudiobook" as never).mockResolvedValue(true as never);
        const prune = jest.spyOn(prisma.audiobook, "deleteMany");

        try {
            const result = await audiobookCacheService.syncAll({ shouldStop: () => false });

            expect(syncOne).toHaveBeenCalledTimes(3);
            expect(result.synced).toBe(3);
            expect(prune).toHaveBeenCalledTimes(1);
            expect(await prisma.audiobook.count({ where: { id: `${P}-stale` } })).toBe(0);
        } finally {
            await prisma.audiobook.deleteMany({ where: { id: { startsWith: P } } });
        }
    });

    describe("one at a time", () => {
        beforeEach(() => {
            jest.spyOn(audiobookCacheService as never, "syncAudiobook" as never).mockResolvedValue(true as never);
        });

        it("claims the run before its first await: a second call in the same tick waits for the run and gets its result", async () => {
            const fetchBooks = jest.spyOn(audiobookshelfService, "getAllAudiobooks").mockResolvedValue(books as never);

            const first = audiobookCacheService.syncAll();
            const second = audiobookCacheService.syncAll();
            const [ran, asked] = await Promise.all([first, second]);

            expect(fetchBooks).toHaveBeenCalledTimes(1);
            expect(asked).toBe(ran);
            expect(ran.synced).toBe(3);
        });

        it("does not answer the second caller until the run has ended", async () => {
            let release!: () => void;
            jest.spyOn(audiobookshelfService, "getAllAudiobooks").mockImplementation(
                () => new Promise((resolve) => (release = () => resolve(books as never))),
            );

            void audiobookCacheService.syncAll();
            let answered = false;
            void audiobookCacheService.syncAll().then(() => (answered = true));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(answered).toBe(false);

            release();
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(answered).toBe(true);
        });

        it("lets a later call run once the first has ended, and after one that failed", async () => {
            expectLog("error");
            const fetchBooks = jest.spyOn(audiobookshelfService, "getAllAudiobooks");
            fetchBooks.mockRejectedValueOnce(new Error("abs down"));
            fetchBooks.mockResolvedValue(books as never);

            await expect(audiobookCacheService.syncAll()).rejects.toThrow("abs down");
            const result = await audiobookCacheService.syncAll();

            expect(result.synced).toBe(3);
            expect(fetchBooks).toHaveBeenCalledTimes(2);
        });
    });
});
