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

describe("backgroundStartSteps", () => {
    // The catch-up work reads and writes the database for a long while, so each task is handed a way to ask whether a
    // shutdown has begun, and stops between its batches once it has. Each service is replaced: only what the steps
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

    beforeEach(() => {
        jest.resetModules();
        jest.doMock("../utils/systemSettings", () => ({ getSystemSettings: mockSettings }));
        jest.doMock("../utils/db", () => ({ prisma: { audiobook: { count: mockAudiobookCount } } }));
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
    });

    async function steps(shutdownHasBegun: () => boolean) {
        const { backgroundStartSteps } = await import("../backgroundStart");
        return backgroundStartSteps(shutdownHasBegun);
    }
    const run = async (all: Awaited<ReturnType<typeof steps>>, name: string) =>
        all.find((step) => step.name === name)!.run();

    it("hands the audiobook sync, the artist counts and the image backfill a stop check that follows the shutdown", async () => {
        let begun = false;
        const all = await steps(() => begun);

        await run(all, "audiobook auto-sync");
        await run(all, "artist counts backfill");
        await run(all, "image backfill");

        const checks = [
            mockSyncAll.mock.calls[0][0]?.shouldStop,
            mockCountsBackfill.mock.calls[0][1]?.shouldStop,
            mockImagesBackfill.mock.calls[0][0]?.shouldStop,
        ];
        for (const check of checks) {
            expect(check).toBeInstanceOf(Function);
            expect(check!()).toBe(false);
        }
        begun = true;
        for (const check of checks) expect(check!()).toBe(true);
    });

    it("runs the same four tasks, in the same order, as before", async () => {
        const all = await steps(() => false);
        expect(all.map((step) => step.name)).toEqual([
            "audiobook auto-sync",
            "sorting albums filed as Discover",
            "artist counts backfill",
            "image backfill",
        ]);
    });
});
