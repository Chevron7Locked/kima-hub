/**
 * The steps the server runs once it is listening: each starts only while no shutdown has begun, so nothing starts
 * after the workers and the database have closed. The shutdown is a real `createShutdown`, with steps that do nothing.
 */

import { createShutdown } from "../shutdown";
import { runStartSteps } from "../startup";
import { expectLog } from "./helpers/expectedLogs";

const idleShutdown = () =>
    createShutdown({ stopAccepting: [], drain: async () => {}, close: [], deadlineMs: 2000, exit: () => {} });

describe("createShutdown", () => {
    it("says whether a shutdown has begun", async () => {
        const shutdown = idleShutdown();
        expect(shutdown.hasBegun()).toBe(false);

        const done = shutdown("SIGTERM");
        expect(shutdown.hasBegun()).toBe(true);
        await done;
        expect(shutdown.hasBegun()).toBe(true);
    });
});

describe("runStartSteps", () => {
    it("runs the steps in order while no shutdown has begun", async () => {
        const shutdown = idleShutdown();
        const started: string[] = [];

        await runStartSteps(
            [
                { name: "first", run: async () => void started.push("first") },
                { name: "second", run: () => void started.push("second") },
            ],
            shutdown.hasBegun,
        );

        expect(started).toEqual(["first", "second"]);
    });

    it("does not start a step reached after a shutdown began, nor any step after it", async () => {
        const shutdown = idleShutdown();
        const started: string[] = [];

        await runStartSteps(
            [
                {
                    name: "first",
                    run: async () => {
                        started.push("first");
                        void shutdown("SIGTERM");
                    },
                },
                { name: "workers", run: () => void started.push("workers") },
                { name: "cron", run: () => void started.push("cron") },
            ],
            shutdown.hasBegun,
        );

        expect(started).toEqual(["first"]);
    });

    it("does not start anything when the shutdown began first", async () => {
        const shutdown = idleShutdown();
        void shutdown("SIGTERM");
        const run = jest.fn();

        await runStartSteps([{ name: "workers", run }], shutdown.hasBegun);

        expect(run).not.toHaveBeenCalled();
    });

    it("stops at a step that throws, naming it, and leaves the later ones unstarted", async () => {
        expectLog("error");
        const later = jest.fn();

        await runStartSteps(
            [
                {
                    name: "music config",
                    run: () => {
                        throw new Error("no settings row");
                    },
                },
                { name: "workers", run: later },
            ],
            () => false,
        );

        expect(later).not.toHaveBeenCalled();
    });
});

describe("createBackgroundStart", () => {
    // The catch-up work reads and writes the database for a long while, so each task is handed a way to ask whether a
    // shutdown has begun, and stops between its batches once it has. Each module is replaced: only what the steps
    // hand them is asked here.
    const mockSettings = jest.fn(async () => ({ audiobookshelfEnabled: true, audiobookshelfUrl: "http://abs" }));
    const mockAudiobookCount = jest.fn(async () => 0);
    const mockSyncAll = jest.fn(async (_options?: { shouldStop?: () => boolean }) => ({ synced: 0 }));
    const mockSortDiscover = jest.fn(async () => null);
    const mockCountsNeeded = jest.fn(async () => true);
    const mockCountsBackfill = jest.fn(async (_progress?: unknown, _options?: { shouldStop?: () => boolean }) => ({
        processed: 0,
        errors: 0,
    }));
    const mockImagesNeeded = jest.fn(async () => ({ needed: true, artistsWithExternalUrls: 1, albumsWithExternalUrls: 1 }));
    const mockImagesBackfill = jest.fn(async (_options?: { shouldStop?: () => boolean }) => {});
    const mockWarmup = jest.fn(async (_options?: { shouldStop?: () => boolean }) => {});
    const mockCoverRepair = jest.fn(async (_options?: { shouldStop?: () => boolean }) => null);

    beforeEach(() => {
        jest.resetModules();
        jest.doMock("../utils/systemSettings", () => ({ getSystemSettings: mockSettings }));
        jest.doMock("../services/coverFormatRepair", () => ({ repairCoverFormatsOnce: mockCoverRepair }));
        jest.doMock("../services/audiobookCache", () => ({ audiobookCacheService: { syncAll: mockSyncAll } }));
        jest.doMock("../services/discovery/sortDiscoverAlbums", () => ({ sortDiscoverAlbums: mockSortDiscover }));
        jest.doMock("../services/artistCountsService", () => ({
            isBackfillNeeded: mockCountsNeeded,
            backfillAllArtistCounts: mockCountsBackfill,
        }));
        jest.doMock("../services/imageBackfill", () => ({
            isImageBackfillNeeded: mockImagesNeeded,
            backfillAllImages: mockImagesBackfill,
        }));
        jest.doMock("../services/dataCache", () => ({ dataCacheService: { warmupCache: mockWarmup } }));
    });

    async function background(shutdownHasBegun: () => boolean) {
        const { createBackgroundStart } = await import("../backgroundStart");
        // The real client, with the one read that decides whether the sync runs answered as an empty cache.
        const { prisma } = await import("../utils/db");
        jest.spyOn(prisma.audiobook, "count").mockImplementation(mockAudiobookCount as never);
        return createBackgroundStart(shutdownHasBegun);
    }
    async function steps(shutdownHasBegun: () => boolean) {
        return (await background(shutdownHasBegun)).steps;
    }
    const run = async (all: Awaited<ReturnType<typeof steps>>, name: string) =>
        all.find((step) => step.name === name)!.run();

    it("hands the audiobook sync, the artist counts, the image backfill and the cover format repair a stop check that follows the shutdown", async () => {
        let begun = false;
        const all = await steps(() => begun);

        await run(all, "audiobook auto-sync");
        await run(all, "artist counts backfill");
        await run(all, "image backfill");
        await run(all, "cover format repair");

        const checks = [
            mockSyncAll.mock.calls[0][0]?.shouldStop,
            mockCountsBackfill.mock.calls[0][1]?.shouldStop,
            mockImagesBackfill.mock.calls[0][0]?.shouldStop,
            mockCoverRepair.mock.calls[0][0]?.shouldStop,
        ];
        for (const check of checks) {
            expect(check).toBeInstanceOf(Function);
            expect(check!()).toBe(false);
        }
        begun = true;
        for (const check of checks) expect(check!()).toBe(true);
    });

    it("runs the same tasks, in the same order, with the cover format repair last", async () => {
        const all = await steps(() => false);
        expect(all.map((step) => step.name)).toEqual([
            "audiobook auto-sync",
            "sorting albums filed as Discover",
            "artist counts backfill",
            "image backfill",
            "cover format repair",
        ]);
    });

    it("logs a repair that fails and does not throw, so the start steps go on", async () => {
        mockCoverRepair.mockRejectedValueOnce(new Error("disk gone"));
        const all = await steps(() => false);

        await expect(run(all, "cover format repair")).resolves.toBeUndefined();
    });
});

describe("createBackgroundStart: the shutdown waits for the catch-up work", () => {
    // The catch-up work uses the database for as long as it runs, so the drain waits for the batch under way before the
    // close steps run, and the batch after it never starts. Each module is replaced by a task the test holds open.
    const held = () => {
        let release!: () => void;
        const done = new Promise<void>((resolve) => (release = resolve));
        return { done, release };
    };
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const until = async (condition: () => boolean) => {
        for (let i = 0; i < 200 && !condition(); i++) await flush();
        expect(condition()).toBe(true);
    };

    const mockSettings = jest.fn(async () => ({ audiobookshelfEnabled: true, audiobookshelfUrl: "http://abs" }));
    const mockSyncAll = jest.fn(async (_options?: { shouldStop?: () => boolean }) => ({ synced: 0 }));
    const mockCountsBackfill = jest.fn(async (_progress?: unknown, _options?: { shouldStop?: () => boolean }) => ({
        processed: 0,
        errors: 0,
    }));
    const mockWarmup = jest.fn(async (_options?: { shouldStop?: () => boolean }) => {});

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        jest.doMock("../utils/systemSettings", () => ({ getSystemSettings: mockSettings }));
        jest.doMock("../services/audiobookCache", () => ({ audiobookCacheService: { syncAll: mockSyncAll } }));
        jest.doMock("../services/discovery/sortDiscoverAlbums", () => ({ sortDiscoverAlbums: jest.fn(async () => null) }));
        jest.doMock("../services/artistCountsService", () => ({
            isBackfillNeeded: jest.fn(async () => true),
            backfillAllArtistCounts: mockCountsBackfill,
        }));
        jest.doMock("../services/imageBackfill", () => ({
            isImageBackfillNeeded: jest.fn(async () => ({ needed: false })),
            backfillAllImages: jest.fn(async () => {}),
        }));
        jest.doMock("../services/dataCache", () => ({ dataCacheService: { warmupCache: mockWarmup } }));
        jest.doMock("../services/coverFormatRepair", () => ({ repairCoverFormatsOnce: jest.fn(async () => null) }));
    });

    async function start() {
        const { createBackgroundStart } = await import("../backgroundStart");
        const { prisma } = await import("../utils/db");
        jest.spyOn(prisma.audiobook, "count").mockResolvedValue(0 as never);
        const events: string[] = [];
        const shutdown = createShutdown({
            stopAccepting: [],
            drain: async () => background.whenEnded(),
            close: [async () => void events.push("database closed")],
            deadlineMs: 5000,
            exit: () => {},
        });
        const background = createBackgroundStart(shutdown.hasBegun);
        return { background, shutdown, events };
    }

    it("closes the database only after the sync under way has ended, and starts no later step", async () => {
        const sync = held();
        mockSyncAll.mockImplementationOnce(async () => {
            await sync.done;
            events.push("sync ended");
            return { synced: 1 };
        });
        const { background, shutdown, events } = await start();

        const started = runStartSteps(background.steps, shutdown.hasBegun);
        await until(() => mockSyncAll.mock.calls.length === 1);

        const closing = shutdown("SIGTERM");
        await flush();
        await flush();
        expect(events).toEqual([]);

        sync.release();
        await closing;
        await started;

        expect(events).toEqual(["sync ended", "database closed"]);
        expect(mockCountsBackfill).not.toHaveBeenCalled();
    });

    it("waits for the cache warmup too", async () => {
        const warm = held();
        mockWarmup.mockImplementationOnce(async () => {
            await warm.done;
            events.push("warmup ended");
        });
        const { background, shutdown, events } = await start();

        background.startCacheWarmup();
        await until(() => mockWarmup.mock.calls.length === 1);
        const closing = shutdown("SIGTERM");
        await flush();
        expect(events).toEqual([]);

        warm.release();
        await closing;

        expect(events).toEqual(["warmup ended", "database closed"]);
    });

    it("waits for work a request started too (an admin backfill, a re-file, a sync), as it does for the catch-up work", async () => {
        const work = held();
        const { shutdown, events } = await start();
        const { runAsRequestWork } = await import("../utils/stopCheck");

        void runAsRequestWork(async () => {
            await work.done;
            events.push("request work ended");
        });
        const closing = shutdown("SIGTERM");
        await flush();
        await flush();
        expect(events).toEqual([]);

        work.release();
        await closing;

        expect(events).toEqual(["request work ended", "database closed"]);
    });

    it("hands the warmup the shutdown's stop check", async () => {
        let begun = false;
        const { createBackgroundStart } = await import("../backgroundStart");
        const background = createBackgroundStart(() => begun);

        background.startCacheWarmup();
        await background.whenEnded();

        const check = mockWarmup.mock.calls[0][0]?.shouldStop;
        expect(check!()).toBe(false);
        begun = true;
        expect(check!()).toBe(true);
    });

    it("has nothing to wait for when no work was started", async () => {
        const { background, shutdown, events } = await start();
        await shutdown("SIGTERM");
        await background.whenEnded();
        expect(events).toEqual(["database closed"]);
    });

    it("does not hang on a task that failed", async () => {
        expectLog("error");
        mockSettings.mockRejectedValueOnce(new Error("settings unreadable"));
        const { background } = await start();

        await background.steps[0].run();
        await background.whenEnded();
    });
});
