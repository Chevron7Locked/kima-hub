/**
 * One progress object covers the whole image backfill run (artists, then albums), and the run's closing log line says
 * whether it finished or was stopped. Real database; the download is replaced.
 */

jest.mock("../imageStorage", () => ({
    ...jest.requireActual("../imageStorage"),
    stageDownloadedImage: jest.fn(),
}));

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { backfillAllImages, getImageBackfillProgress } from "../imageBackfill";
import { stageDownloadedImage } from "../imageStorage";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";

jest.setTimeout(30_000);

const P = "zz-imgbf";
const download = stageDownloadedImage as jest.Mock;

/** What each staged picture was told: put in place, or thrown away. */
const placed: Record<string, "published" | "discarded"> = {};

/** A downloaded picture waiting to be put in place at `address`. */
function staged(address: string) {
    return {
        address,
        publish: async () => {
            placed[address] = "published";
        },
        discard: async () => {
            placed[address] = "discarded";
        },
    };
}

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
    for (const address of Object.keys(placed)) delete placed[address];
    // Only our own rows are stored; any row another test left behind fails.
    download.mockImplementation(async (_url: string, id: string) => (ours(id) ? staged(`native:x/${id}.jpg`) : null));
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
            return ours(id) ? staged(`native:x/${id}.jpg`) : null;
        });

        await backfillAllImages();

        expect(during!.inProgress).toBe(true);
        expect(during!.total).toBeGreaterThanOrEqual(5);
    });
});

describe("backfillAllImages and an address edited while it downloads", () => {
    it("leaves the newer address a person set, for the next start, and counts the row as skipped, not stored", async () => {
        await seed();
        download.mockImplementation(async (_url: string, id: string) => {
            if (id === `${P}-ar-1`) await prisma.artist.update({ where: { id }, data: { heroUrl: "http://example.invalid/edited.jpg" } });
            if (id === `${P}-al-1`) await prisma.album.update({ where: { id }, data: { coverUrl: "http://example.invalid/edited-cover.jpg" } });
            return ours(id) ? staged(`native:x/${id}.jpg`) : null;
        });

        await backfillAllImages();

        expect((await prisma.artist.findUniqueOrThrow({ where: { id: `${P}-ar-1` } })).heroUrl).toBe("http://example.invalid/edited.jpg");
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: `${P}-ar-2` } })).heroUrl).toBe(`native:x/${P}-ar-2.jpg`);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}-al-1` } })).coverUrl).toBe("http://example.invalid/edited-cover.jpg");
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}-al-2` } })).coverUrl).toBe(`native:x/${P}-al-2.jpg`);
        expect(getImageBackfillProgress()).toMatchObject({ success: 3, skipped: 2, failed: 0 });
        // The picture of an edited row is thrown away, not put in place.
        expect(placed[`native:x/${P}-ar-1.jpg`]).toBe("discarded");
        expect(placed[`native:x/${P}-al-1.jpg`]).toBe("discarded");
        expect(placed[`native:x/${P}-ar-2.jpg`]).toBe("published");
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
            return ours(id) ? staged(`native:x/${id}.jpg`) : null;
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
            if (id !== `${P}-al-3`) return ours(id) ? staged(`native:x/${id}.jpg`) : null;
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

/**
 * A picture stored locally in place of the external one it came from changes the address a client is handed, so the
 * library marker moves once for the run, when a listed artist or album shows it.
 */
describe("backfillAllImages and the library marker", () => {
    /** One artist with an album and a song, holding external pictures; `location` DISCOVER lists nothing to a client. */
    async function seedListed(location: "LIBRARY" | "DISCOVER", own: { userHeroUrl?: string; userCoverUrl?: string } = {}) {
        const id = `${P}-ml`;
        await prisma.artist.create({
            data: { id, name: id, normalizedName: id, identityKey: id, heroUrl: "http://example.invalid/a.jpg", userHeroUrl: own.userHeroUrl },
        });
        await prisma.album.create({
            data: {
                id: `${id}-al`, artistId: id, title: id, identityKey: `${id}-al`, rgMbid: `${id}-al`, primaryType: "Album",
                coverUrl: "http://example.invalid/c.jpg", userCoverUrl: own.userCoverUrl, location,
            },
        });
        await prisma.track.create({
            data: { id: `${id}-t`, albumId: `${id}-al`, title: "T", trackNo: 1, duration: 100, filePath: `/m/${id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
    beforeEach(async () => {
        await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
        await clean();
    });
    afterAll(() => prisma.track.deleteMany({ where: { id: { startsWith: P } } }));

    it("moves the marker when a listed artist's picture is stored locally", async () => {
        await seedListed("LIBRARY");
        expect(await markerMoves(() => backfillAllImages())).toBe(true);
    });

    it("leaves the marker when the person's own pictures show instead, or the album is a Discover one", async () => {
        await seedListed("LIBRARY", { userHeroUrl: "native:artists/mine.jpg", userCoverUrl: "native:albums/mine.jpg" });
        expect(await markerMoves(() => backfillAllImages())).toBe(false);

        await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
        await clean();
        await seedListed("DISCOVER");
        expect(await markerMoves(() => backfillAllImages())).toBe(false);
    });
});
