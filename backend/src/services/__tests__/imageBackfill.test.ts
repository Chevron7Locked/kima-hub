/**
 * One progress object covers the whole image backfill run (artists, then albums), and the run's closing log line says
 * whether it finished or was stopped. Real database; the download is replaced.
 */

jest.mock("../imageStorage", () => ({
    ...jest.requireActual("../imageStorage"),
    downloadAndStoreImage: jest.fn(),
}));

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { backfillAllImages, getImageBackfillProgress } from "../imageBackfill";
import { downloadAndStoreImage } from "../imageStorage";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const P = "zz-imgbf";
const download = downloadAndStoreImage as jest.Mock;

async function clean() {
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** Two artists and three albums of one of them, all holding an external image address. */
async function seed() {
    for (const n of [1, 2]) {
        const id = `${P}-ar-${n}`;
        await prisma.artist.create({
            data: { id, name: id, normalizedName: id, identityKey: id, heroUrl: "http://example.invalid/a.jpg" },
        });
    }
    for (const n of [1, 2, 3]) {
        const id = `${P}-al-${n}`;
        await prisma.album.create({
            data: {
                id,
                artistId: `${P}-ar-1`,
                title: id,
                identityKey: id,
                rgMbid: id,
                primaryType: "Album",
                coverUrl: "http://example.invalid/c.jpg",
            },
        });
    }
}

const ours = (id: string) => id.startsWith(P);

beforeEach(async () => {
    await clean();
    jest.restoreAllMocks();
    download.mockReset();
    // Only our own rows are stored; any row another test left behind fails.
    download.mockImplementation(async (_url: string, id: string) => (ours(id) ? `native:x/${id}.jpg` : null));
});

afterAll(async () => {
    await clean();
    await closeEngineConnections();
});

const infoLines = (info: jest.SpyInstance) => info.mock.calls.map((call) => String(call[0]));

describe("backfillAllImages progress", () => {
    it("counts the artists and the albums of one run in one object, so the status page shows the whole run", async () => {
        await seed();

        await backfillAllImages();

        const progress = getImageBackfillProgress();
        expect(progress.inProgress).toBe(false);
        expect(progress.success).toBe(5);
        expect(progress.failed).toBe(0);
        expect(progress.processed).toBe(progress.total);
        expect(progress.total).toBeGreaterThanOrEqual(5);
    });

    it("starts a new run from zero", async () => {
        await seed();
        await backfillAllImages();
        expect(getImageBackfillProgress().success).toBe(5);

        await backfillAllImages();

        // Everything stored in the first run now holds a native path, so nothing is left to do.
        const again = getImageBackfillProgress();
        expect(again.success).toBe(0);
        expect(again.processed).toBe(again.total);
    });

    it("shows the artists' total and the albums' together while the artists are still being downloaded", async () => {
        await seed();
        let during: ReturnType<typeof getImageBackfillProgress> | undefined;
        download.mockImplementation(async (_url: string, id: string) => {
            during ??= getImageBackfillProgress();
            return ours(id) ? `native:x/${id}.jpg` : null;
        });

        await backfillAllImages();

        expect(during!.inProgress).toBe(true);
        expect(during!.total).toBeGreaterThanOrEqual(5);
    });
});

describe("backfillAllImages closing log line", () => {
    it("says complete, with the counts, when every image was gone through", async () => {
        await seed();
        const info = jest.spyOn(logger, "info").mockImplementation(() => {});

        await backfillAllImages();

        const lines = infoLines(info);
        expect(lines.filter((l) => /complete/i.test(l))).toHaveLength(1);
        expect(lines.find((l) => /complete/i.test(l))).toMatch(/5 success, 0 failed, 0 skipped/);
        expect(lines.some((l) => /stopped/i.test(l))).toBe(false);
    });

    it("says stopped, with the counts, and never complete, when a stop ended the run", async () => {
        await seed();
        let stop = false;
        download.mockImplementation(async (_url: string, id: string) => {
            stop = true;
            return ours(id) ? `native:x/${id}.jpg` : null;
        });
        const info = jest.spyOn(logger, "info").mockImplementation(() => {});

        await backfillAllImages({ shouldStop: () => stop });

        const lines = infoLines(info);
        expect(lines.some((l) => /complete/i.test(l))).toBe(false);
        expect(lines.filter((l) => /stopped/i.test(l))).toHaveLength(1);
        expect(lines.find((l) => /stopped/i.test(l))).toMatch(/\d+ success, \d+ failed, \d+ skipped/);
    });

    it("says stopped when the stop cut the last download short, though nothing was left to read", async () => {
        await seed();
        let stop = false;
        download.mockImplementation(async (_url: string, id: string, _kind: string, signal?: AbortSignal) => {
            if (id !== `${P}-al-3`) return ours(id) ? `native:x/${id}.jpg` : null;
            stop = true;
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
            return null;
        });
        const info = jest.spyOn(logger, "info").mockImplementation(() => {});

        await backfillAllImages({ shouldStop: () => stop });

        const lines = infoLines(info);
        expect(lines.some((l) => /complete/i.test(l))).toBe(false);
        expect(lines.some((l) => /stopped/i.test(l))).toBe(true);
    });

    it("says stopped when the stop was there before the first page", async () => {
        await seed();
        const info = jest.spyOn(logger, "info").mockImplementation(() => {});

        await backfillAllImages({ shouldStop: () => true });

        const lines = infoLines(info);
        expect(lines.some((l) => /complete/i.test(l))).toBe(false);
        expect(lines.some((l) => /stopped/i.test(l))).toBe(true);
    });
});
