/**
 * The one-time pass that gives every stored cover value a version, so afterwards no stored value is unversioned: album
 * covers (the scanner's and a person's), artist pictures, and the audiobook cover versions. It also files the scanner's
 * old root-folder covers (`native:<id>.jpg`) under `albums/` where every album cover is. Real files in a temp folder and
 * the real test database; the done marker is on the settings row.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = `/tmp/kima-test-coverversions-${process.pid}`;

jest.mock("../../config", () => {
    const actual = jest.requireActual("../../config");
    return {
        ...actual,
        config: {
            ...actual.config,
            music: {
                ...actual.config.music,
                transcodeCachePath: `/tmp/kima-test-coverversions-${process.pid}/transcode`,
                musicPath: `/tmp/kima-test-coverversions-${process.pid}/music`,
            },
        },
    };
});
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { backfillCoverVersionsOnce, rewriteCoverValues } from "../coverVersionBackfill";
import { flushShownChanges } from "../shownChanges";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";
import { versionOfFile } from "../imageStorage";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const P = `cvb${process.pid}`;
const covers = path.join(ROOT, "covers");
const audiobooks = path.join(ROOT, "music", "cover-cache", "audiobooks");

async function jpeg(): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp(randomBytes(60 * 60 * 3), { raw: { width: 60, height: 60, channels: 3 } }).jpeg().toBuffer();
}
async function put(file: string): Promise<string | null> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await jpeg());
    return versionOfFile(file);
}

let hadSettings = false;
let before: Date | null = null;
beforeAll(async () => {
    const row = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    hadSettings = row !== null;
    before = row?.coverVersionsAddedAt ?? null;
});
afterAll(async () => {
    if (hadSettings) {
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", coverVersionsAddedAt: before },
            update: { coverVersionsAddedAt: before },
        });
    } else {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    }
    invalidateSystemSettingsCache();
    fs.rmSync(ROOT, { recursive: true, force: true });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.audiobook.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

async function notYetRun() {
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", coverVersionsAddedAt: null },
        update: { coverVersionsAddedAt: null },
    });
    invalidateSystemSettingsCache();
}
const marker = async () => (await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).coverVersionsAddedAt;

const artistId = `${P}_artist`;
let n = 0;
const album = (data: { coverUrl?: string | null; userCoverUrl?: string | null }) => {
    n++;
    return prisma.album.create({ data: { id: `${P}_alb${n}`, rgMbid: `${P}-rg${n}`, artistId, title: `T${n}`, identityKey: `${P}-t${n}`, primaryType: "Album", ...data } });
};
const albumRow = (id: string) => prisma.album.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    jest.clearAllMocks();
    await notYetRun();
    await prisma.artist.create({ data: { id: artistId, name: `Backfill ${P}`, identityKey: `${P}_ik` } });
});
afterEach(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.audiobook.deleteMany({ where: { id: { startsWith: P } } });
});

describe("backfillCoverVersionsOnce", () => {
    it("versions every unversioned stored value: album covers, a person's album cover, and the artist picture", async () => {
        const albumVersion = await put(path.join(covers, "albums", `${P}_a.jpg`));
        const userVersion = await put(path.join(covers, "albums", `${P}_u.jpg`));
        const heroVersion = await put(path.join(covers, "artists", `${P}_h.jpg`));
        const a = await album({ coverUrl: `native:albums/${P}_a.jpg`, userCoverUrl: `native:albums/${P}_u.jpg` });
        await prisma.artist.update({ where: { id: artistId }, data: { heroUrl: `native:artists/${P}_h.jpg`, userHeroUrl: `native:artists/${P}_h.jpg` } });

        const result = await backfillCoverVersionsOnce({});

        expect(result).toMatchObject({ stopped: false, failed: 0 });
        const row = await albumRow(a.id);
        expect(row.coverUrl).toBe(`native:albums/${P}_a.jpg?v=${albumVersion}`);
        expect(row.userCoverUrl).toBe(`native:albums/${P}_u.jpg?v=${userVersion}`);
        const artist = await prisma.artist.findUniqueOrThrow({ where: { id: artistId } });
        expect(artist.heroUrl).toBe(`native:artists/${P}_h.jpg?v=${heroVersion}`);
        expect(artist.userHeroUrl).toBe(`native:artists/${P}_h.jpg?v=${heroVersion}`);
    });

    it("versions each file once for every row that shares it", async () => {
        const version = await put(path.join(covers, "albums", `${P}_shared.jpg`));
        const a = await album({ coverUrl: `native:albums/${P}_shared.jpg` });
        const b = await album({ coverUrl: `native:albums/${P}_shared.jpg` });

        await backfillCoverVersionsOnce({});

        expect((await albumRow(a.id)).coverUrl).toBe(`native:albums/${P}_shared.jpg?v=${version}`);
        expect((await albumRow(b.id)).coverUrl).toBe(`native:albums/${P}_shared.jpg?v=${version}`);
    });

    it("files the scanner's old root-folder cover under albums/, and keeps its value pointing at it", async () => {
        const version = await put(path.join(covers, `${P}_old.jpg`));
        const a = await album({ coverUrl: `native:${P}_old.jpg` });

        const result = await backfillCoverVersionsOnce({});

        expect(result).toMatchObject({ moved: 1 });
        expect((await albumRow(a.id)).coverUrl).toBe(`native:albums/${P}_old.jpg?v=${version}`);
        expect(fs.existsSync(path.join(covers, "albums", `${P}_old.jpg`))).toBe(true);
        expect(fs.existsSync(path.join(covers, `${P}_old.jpg`))).toBe(false);
    });

    it("files a root-folder cover the format repair or a scan already gave a version, as it does an unversioned one", async () => {
        const version = await put(path.join(covers, `${P}_vroot.jpg`));
        const a = await album({ coverUrl: `native:${P}_vroot.jpg?v=${version}`, userCoverUrl: `native:${P}_vroot.jpg?v=${version}` });

        const result = await backfillCoverVersionsOnce({});

        expect(result).toMatchObject({ moved: 1 });
        const row = await albumRow(a.id);
        expect(row.coverUrl).toBe(`native:albums/${P}_vroot.jpg?v=${version}`);
        expect(row.userCoverUrl).toBe(`native:albums/${P}_vroot.jpg?v=${version}`);
        expect(fs.existsSync(path.join(covers, `${P}_vroot.jpg`))).toBe(false);
        expect(fs.existsSync(path.join(covers, "albums", `${P}_vroot.jpg`))).toBe(true);
    });

    it("puts a root-folder cover back where it was when its values cannot be rewritten, so they still point at a file", async () => {
        const version = await put(path.join(covers, `${P}_back.jpg`));
        const a = await album({ coverUrl: `native:${P}_back.jpg` });
        // The rewrite is one UPDATE ... RETURNING statement; the first one on an album fails.
        const realQuery = prisma.$queryRaw.bind(prisma);
        let failed = false;
        const failing = jest.spyOn(prisma, "$queryRaw").mockImplementation(((query: { sql?: string }) => {
            if (!failed && query.sql?.includes('UPDATE "Album"')) {
                failed = true;
                return Promise.reject(new Error("database away"));
            }
            return realQuery(query as never);
        }) as never);

        const result = await backfillCoverVersionsOnce({});
        failing.mockRestore();

        expect(result).toMatchObject({ failed: 1, moved: 0 });
        expect((await albumRow(a.id)).coverUrl).toBe(`native:${P}_back.jpg`);
        expect(await versionOfFile(path.join(covers, `${P}_back.jpg`))).toBe(version);
        expect(fs.existsSync(path.join(covers, "albums", `${P}_back.jpg`))).toBe(false);
        expect(await marker()).toBeNull();
    });

    it("leaves a root-folder value where it is when albums/ already holds a cover of that name, and only versions it", async () => {
        const version = await put(path.join(covers, `${P}_dup.jpg`));
        const there = await put(path.join(covers, "albums", `${P}_dup.jpg`));
        const a = await album({ coverUrl: `native:${P}_dup.jpg` });

        const result = await backfillCoverVersionsOnce({});

        expect(result).toMatchObject({ moved: 0 });
        expect((await albumRow(a.id)).coverUrl).toBe(`native:${P}_dup.jpg?v=${version}`);
        expect(await versionOfFile(path.join(covers, "albums", `${P}_dup.jpg`))).toBe(there);
    });

    it("leaves a value whose file is missing as it is, and still finishes", async () => {
        const a = await album({ coverUrl: `native:albums/${P}_gone.jpg` });

        const result = await backfillCoverVersionsOnce({});

        expect(result).toMatchObject({ missing: 1, failed: 0 });
        expect((await albumRow(a.id)).coverUrl).toBe(`native:albums/${P}_gone.jpg`);
        expect(await marker()).not.toBeNull();
    });

    it("leaves values already versioned, external addresses and empty values alone", async () => {
        await put(path.join(covers, "albums", `${P}_v.jpg`));
        const a = await album({ coverUrl: `native:albums/${P}_v.jpg?v=0123456789`, userCoverUrl: "https://img.example/c.jpg" });
        const b = await album({ coverUrl: null });

        await backfillCoverVersionsOnce({});

        expect(await albumRow(a.id)).toMatchObject({ coverUrl: `native:albums/${P}_v.jpg?v=0123456789`, userCoverUrl: "https://img.example/c.jpg" });
        expect((await albumRow(b.id)).coverUrl).toBeNull();
    });

    it("does not follow a value out of the covers folder", async () => {
        fs.mkdirSync(ROOT, { recursive: true });
        fs.writeFileSync(path.join(ROOT, "outside.jpg"), await jpeg());
        const a = await album({ coverUrl: "native:../outside.jpg" });

        const result = await backfillCoverVersionsOnce({});

        expect(result).toMatchObject({ missing: 1 });
        expect((await albumRow(a.id)).coverUrl).toBe("native:../outside.jpg");
    });

    it("gives an audiobook with a cached cover and no version the version of that file", async () => {
        const file = path.join(audiobooks, `${P}_book.jpg`);
        const version = await put(file);
        await prisma.audiobook.create({ data: { id: `${P}_book`, title: "B", audioUrl: "x", localCoverPath: file } });
        await prisma.audiobook.create({ data: { id: `${P}_nocover`, title: "N", audioUrl: "x" } });
        await prisma.audiobook.create({ data: { id: `${P}_lost`, title: "L", audioUrl: "x", localCoverPath: path.join(audiobooks, "nope.jpg") } });

        const result = await backfillCoverVersionsOnce({});

        expect(result).toMatchObject({ audiobooks: 1 });
        expect((await prisma.audiobook.findUniqueOrThrow({ where: { id: `${P}_book` } })).coverVersion).toBe(version);
        expect((await prisma.audiobook.findUniqueOrThrow({ where: { id: `${P}_nocover` } })).coverVersion).toBeNull();
        expect((await prisma.audiobook.findUniqueOrThrow({ where: { id: `${P}_lost` } })).coverVersion).toBeNull();
    });

    it("records the marker through the settings save, and then does nothing on the next start", async () => {
        const a = await album({ coverUrl: `native:albums/${P}_m.jpg` });
        expect(await marker()).toBeNull();

        await backfillCoverVersionsOnce({});
        expect(await marker()).not.toBeNull();

        await put(path.join(covers, "albums", `${P}_m.jpg`));
        expect(await backfillCoverVersionsOnce({})).toBeNull();
        expect((await albumRow(a.id)).coverUrl).toBe(`native:albums/${P}_m.jpg`);
    });

    it("does nothing on a new install, which has no settings row yet", async () => {
        await put(path.join(covers, "albums", `${P}_n.jpg`));
        const a = await album({ coverUrl: `native:albums/${P}_n.jpg` });
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        invalidateSystemSettingsCache();

        expect(await backfillCoverVersionsOnce({})).toBeNull();
        expect((await albumRow(a.id)).coverUrl).toBe(`native:albums/${P}_n.jpg`);
    });

    it("stops between values at a shutdown, without marking the pass done", async () => {
        for (const name of ["s1", "s2", "s3", "s4"]) {
            await put(path.join(covers, "albums", `${P}_${name}.jpg`));
            await album({ coverUrl: `native:albums/${P}_${name}.jpg` });
        }
        let asked = 0;

        const result = await backfillCoverVersionsOnce({ shouldStop: () => ++asked > 2 });

        expect(result).toMatchObject({ stopped: true });
        expect(result!.versioned).toBeLessThan(4);
        expect(await marker()).toBeNull();
    });

    it("picks up where a stopped pass left off on the next start", async () => {
        for (const name of ["r1", "r2", "r3"]) {
            await put(path.join(covers, "albums", `${P}_${name}.jpg`));
            await album({ coverUrl: `native:albums/${P}_${name}.jpg` });
        }
        let asked = 0;
        await backfillCoverVersionsOnce({ shouldStop: () => ++asked > 1 });

        const result = await backfillCoverVersionsOnce({});

        expect(result).toMatchObject({ stopped: false });
        const unversioned = await prisma.album.count({ where: { id: { startsWith: P }, coverUrl: { not: { contains: "?v=" } } } });
        expect(unversioned).toBe(0);
        expect(await marker()).not.toBeNull();
    });
});

/**
 * A version stored on a cover value changes the address a client is handed for it (the cover id carries the version), so a
 * listed artist or album whose shown picture got one moves the library marker, once for the pass.
 */
describe("cover versions and the library marker", () => {
    const withSong = (albumId: string) =>
        prisma.track.create({
            data: { id: `${albumId}_t`, albumId, title: "T", trackNo: 1, duration: 100, filePath: `/m/${albumId}.flac`, fileModified: new Date(), fileSize: 1 },
        });

    it("moves the marker when the pass versions the cover of a listed album", async () => {
        await put(path.join(covers, "albums", `${P}_m.jpg`));
        const a = await album({ coverUrl: `native:albums/${P}_m.jpg` });
        await withSong(a.id);
        expect(await markerMoves(() => backfillCoverVersionsOnce({}))).toBe(true);
    });

    it("moves the marker when the pass versions the picture of a listed artist", async () => {
        await put(path.join(covers, "artists", `${P}_mh.jpg`));
        await prisma.artist.update({ where: { id: artistId }, data: { heroUrl: `native:artists/${P}_mh.jpg` } });
        const a = await album({});
        await withSong(a.id);
        expect(await markerMoves(() => backfillCoverVersionsOnce({}))).toBe(true);
    });

    it("leaves the marker when the person's own cover shows, or the album is a Discover one", async () => {
        await put(path.join(covers, "albums", `${P}_o.jpg`));
        const own = await album({ coverUrl: `native:albums/${P}_o.jpg`, userCoverUrl: "https://pictures.example/mine.jpg" });
        await withSong(own.id);
        expect(await markerMoves(() => backfillCoverVersionsOnce({}))).toBe(false);

        await notYetRun();
        await put(path.join(covers, "albums", `${P}_d.jpg`));
        const discover = await album({ coverUrl: `native:albums/${P}_d.jpg` });
        await prisma.album.update({ where: { id: discover.id }, data: { location: "DISCOVER" } });
        await withSong(discover.id);
        expect(await markerMoves(() => backfillCoverVersionsOnce({}))).toBe(false);
    });

    it("moves the marker for a version the format repair stores through rewriteCoverValues", async () => {
        const a = await album({ coverUrl: `native:albums/${P}_r.jpg?v=0123456789ab` });
        await withSong(a.id);
        expect(
            await markerMoves(async () => {
                expect(await rewriteCoverValues(`albums/${P}_r.jpg`, "ba9876543210")).toBe(1);
                await flushShownChanges();
            }),
        ).toBe(true);
    });
});
