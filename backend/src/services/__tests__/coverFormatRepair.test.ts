/**
 * The one-time pass over stored covers saved before every stored picture became a JPEG: a `.jpg` holding PNG or WebP bytes
 * is converted in place, atomically; a file that is no picture is left alone and logged. Real files in a temp folder, and
 * the done marker in the real test database.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = `/tmp/kima-test-coverrepair-${process.pid}`;

jest.mock("../../config", () => {
    const actual = jest.requireActual("../../config");
    return {
        ...actual,
        config: {
            ...actual.config,
            music: {
                ...actual.config.music,
                transcodeCachePath: `/tmp/kima-test-coverrepair-${process.pid}/transcode`,
                musicPath: `/tmp/kima-test-coverrepair-${process.pid}/music`,
            },
        },
    };
});
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { repairCoverFormatsOnce } from "../coverFormatRepair";
import { versionOfFile } from "../imageStorage";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const P = `repair${process.pid}`;
const covers = path.join(ROOT, "covers");
const audiobooks = path.join(ROOT, "music", "cover-cache", "audiobooks");

async function picture(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp(randomBytes(100 * 100 * 3), { raw: { width: 100, height: 100, channels: 3 } })[format]().toBuffer();
}
async function formatOf(file: string): Promise<string | undefined> {
    const sharp = (await import("sharp")).default;
    return (await sharp(file).metadata()).format;
}
function put(file: string, bytes: Buffer) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
}

let hadSettings = false;
let before: Date | null = null;
beforeAll(async () => {
    const row = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    hadSettings = row !== null;
    before = row?.coverFormatsRepairedAt ?? null;
});
afterAll(async () => {
    if (hadSettings) {
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", coverFormatsRepairedAt: before },
            update: { coverFormatsRepairedAt: before },
        });
    } else {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    }
    invalidateSystemSettingsCache();
    fs.rmSync(ROOT, { recursive: true, force: true });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

/** The settings row, with the pass not yet run. */
async function notYetRun() {
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", coverFormatsRepairedAt: null },
        update: { coverFormatsRepairedAt: null },
    });
    invalidateSystemSettingsCache();
}
const marker = async () => (await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).coverFormatsRepairedAt;

beforeEach(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    jest.clearAllMocks();
    await notYetRun();
});
afterEach(() => jest.restoreAllMocks());

describe("repairCoverFormatsOnce", () => {
    it("converts PNG and WebP bytes under a .jpg name, in the artists, albums, covers and audiobook folders", async () => {
        const files = [
            path.join(covers, "artists", "a1.jpg"),
            path.join(covers, "albums", "b1.jpg"),
            path.join(covers, "c1.jpg"),
            path.join(audiobooks, "d1.jpg"),
            path.join(covers, "albums", "b1_w300.jpg"),
        ];
        put(files[0], await picture("png"));
        put(files[1], await picture("webp"));
        put(files[2], await picture("png"));
        put(files[3], await picture("webp"));
        put(files[4], await picture("png"));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ converted: 5, notPictures: 0, stopped: false });
        for (const file of files) expect(await formatOf(file)).toBe("jpeg");
    });

    it("leaves a real jpeg byte for byte, and files of other names", async () => {
        const jpeg = await picture("jpeg");
        const png = await picture("png");
        put(path.join(covers, "albums", "ok.jpg"), jpeg);
        put(path.join(covers, "albums", "own.png"), png);

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ converted: 0 });
        expect(fs.readFileSync(path.join(covers, "albums", "ok.jpg")).equals(jpeg)).toBe(true);
        expect(fs.readFileSync(path.join(covers, "albums", "own.png")).equals(png)).toBe(true);
    });

    it("leaves a symbolic link named .jpg alone, and the file it points at", async () => {
        const png = await picture("png");
        put(path.join(ROOT, "elsewhere", "target.png"), png);
        fs.mkdirSync(path.join(covers, "albums"), { recursive: true });
        fs.symlinkSync(path.join(ROOT, "elsewhere", "target.png"), path.join(covers, "albums", "link.jpg"));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ converted: 0, failed: 0 });
        expect(fs.lstatSync(path.join(covers, "albums", "link.jpg")).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(path.join(ROOT, "elsewhere", "target.png")).equals(png)).toBe(true);
    });

    it("leaves a file that is no picture alone, logs it, and still finishes", async () => {
        const junk = Buffer.alloc(2000, 7);
        put(path.join(covers, "albums", "junk.jpg"), junk);
        put(path.join(covers, "albums", "empty.jpg"), Buffer.alloc(0));
        put(path.join(covers, "albums", "p.jpg"), await picture("png"));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ converted: 1, notPictures: 2 });
        expect(fs.readFileSync(path.join(covers, "albums", "junk.jpg")).equals(junk)).toBe(true);
        const logged = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
        expect(logged.some((line) => line.includes("junk.jpg"))).toBe(true);
        expect(await marker()).not.toBeNull();
    });

    it("leaves no temporary file behind, and does not touch an orphan .part name", async () => {
        put(path.join(covers, "albums", "p.jpg"), await picture("png"));
        put(path.join(covers, "albums", "q.jpg.1.abc.part"), await picture("png"));

        await repairCoverFormatsOnce({});

        expect(fs.readdirSync(path.join(covers, "albums")).sort()).toEqual(["p.jpg", "q.jpg.1.abc.part"]);
    });

    it("records the marker through the settings save, and then does nothing on the next start", async () => {
        put(path.join(covers, "albums", "p.jpg"), await picture("png"));
        expect(await marker()).toBeNull();

        await repairCoverFormatsOnce({});
        expect(await marker()).not.toBeNull();

        const late = await picture("webp");
        put(path.join(covers, "albums", "late.jpg"), late);
        expect(await repairCoverFormatsOnce({})).toBeNull();
        expect(fs.readFileSync(path.join(covers, "albums", "late.jpg")).equals(late)).toBe(true);
    });

    it("does nothing on a new install, which has no settings row yet", async () => {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        invalidateSystemSettingsCache();
        const png = await picture("png");
        put(path.join(covers, "albums", "p.jpg"), png);

        expect(await repairCoverFormatsOnce({})).toBeNull();
        expect(fs.readFileSync(path.join(covers, "albums", "p.jpg")).equals(png)).toBe(true);
    });

    it("stops between files once the shutdown has begun, and then does not mark it done", async () => {
        for (let i = 0; i < 4; i++) put(path.join(covers, "albums", `p${i}.jpg`), await picture("png"));
        let asked = 0;

        const result = await repairCoverFormatsOnce({ shouldStop: () => ++asked > 2 });

        expect(result).toMatchObject({ stopped: true });
        expect(result!.converted).toBeLessThan(4);
        expect(await marker()).toBeNull();
    });

    it("does not mark it done when a file could not be written, so the next start tries again", async () => {
        put(path.join(covers, "albums", "p.jpg"), await picture("png"));
        jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("read-only"));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ converted: 0, failed: 1 });
        expect(await marker()).toBeNull();
        expect(await formatOf(path.join(covers, "albums", "p.jpg"))).toBe("png");
    });

    it("drops a conversion when the file was written anew after it was read, so the newer write wins", async () => {
        const file = path.join(covers, "albums", "p.jpg");
        put(file, await picture("png"));
        const newer = await picture("jpeg");
        const realRead = fs.promises.readFile;
        jest.spyOn(fs.promises, "readFile").mockImplementationOnce(async (...args: Parameters<typeof realRead>) => {
            const old = await realRead(...args);
            // A download of the same cover lands while the pass holds the old bytes.
            fs.writeFileSync(file, newer);
            const later = new Date(Date.now() + 5000);
            fs.utimesSync(file, later, later);
            return old;
        });

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ converted: 0, superseded: 1, failed: 0 });
        expect(fs.readFileSync(file).equals(newer)).toBe(true);
        expect(fs.readdirSync(path.join(covers, "albums"))).toEqual(["p.jpg"]);
        expect(await marker()).not.toBeNull();
    });

    it("drops a conversion when the newer write is the same size, going by its time", async () => {
        const file = path.join(covers, "albums", "p.jpg");
        const old = await picture("png");
        put(file, old);
        const sameSize = Buffer.from(old);
        sameSize[sameSize.length - 20] ^= 0xff;
        const realRead = fs.promises.readFile;
        jest.spyOn(fs.promises, "readFile").mockImplementationOnce(async (...args: Parameters<typeof realRead>) => {
            const read = await realRead(...args);
            fs.writeFileSync(file, sameSize);
            const later = new Date(Date.now() + 5000);
            fs.utimesSync(file, later, later);
            return read;
        });

        expect(await repairCoverFormatsOnce({})).toMatchObject({ converted: 0, superseded: 1 });
        expect(fs.readFileSync(file).equals(sameSize)).toBe(true);
    });

    it("does not bring back a file deleted after it was read", async () => {
        const file = path.join(covers, "albums", "p.jpg");
        put(file, await picture("png"));
        const realRead = fs.promises.readFile;
        jest.spyOn(fs.promises, "readFile").mockImplementationOnce(async (...args: Parameters<typeof realRead>) => {
            const read = await realRead(...args);
            fs.rmSync(file);
            return read;
        });

        expect(await repairCoverFormatsOnce({})).toMatchObject({ converted: 0, superseded: 1, failed: 0 });
        expect(fs.readdirSync(path.join(covers, "albums"))).toEqual([]);
    });

    it("copes with folders that do not exist", async () => {
        expect(await repairCoverFormatsOnce({})).toMatchObject({ converted: 0, stopped: false });
        expect(await marker()).not.toBeNull();
    });
});

describe("an old artist picture saved as .png or .webp", () => {
    const artists = path.join(covers, "artists");
    const artist = (name: string, heroUrl: string | null) =>
        prisma.artist.create({ data: { id: `${P}_${name}`, name: `Repair ${name}`, identityKey: `${P}_${name}_ik`, heroUrl } });
    const hero = async (name: string) => (await prisma.artist.findUniqueOrThrow({ where: { id: `${P}_${name}` } })).heroUrl;

    afterEach(() => prisma.artist.deleteMany({ where: { id: { startsWith: P } } }));

    it.each(["png", "webp"] as const)("is converted to <id>.jpg, its artist moved over to it, and the old file removed (%s)", async (format) => {
        await artist("a", `native:artists/${P}_a.${format}`);
        put(path.join(artists, `${P}_a.${format}`), await picture(format));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ artistPicturesConverted: 1, failed: 0 });
        expect(await formatOf(path.join(artists, `${P}_a.jpg`))).toBe("jpeg");
        expect(await hero("a")).toBe(`native:artists/${P}_a.jpg?v=${await versionOfFile(path.join(artists, `${P}_a.jpg`))}`);
        expect(fs.readdirSync(artists)).toEqual([`${P}_a.jpg`]);
        expect(await marker()).not.toBeNull();
    });

    it("moves every row that pointed at it, and no other artist", async () => {
        await artist("b", `native:artists/${P}_b.png`);
        await artist("other", `native:artists/${P}_other.jpg`);
        await artist("remote", "https://img.example/x.jpg");
        put(path.join(artists, `${P}_b.png`), await picture("png"));

        await repairCoverFormatsOnce({});

        expect(await hero("b")).toBe(`native:artists/${P}_b.jpg?v=${await versionOfFile(path.join(artists, `${P}_b.jpg`))}`);
        expect(await hero("other")).toBe(`native:artists/${P}_other.jpg`);
        expect(await hero("remote")).toBe("https://img.example/x.jpg");
    });

    it("replaces an older .jpg of the artist, since the row showed the .png; and drops its smaller copies", async () => {
        await artist("c", `native:artists/${P}_c.png`);
        const olderJpeg = await picture("jpeg");
        put(path.join(artists, `${P}_c.png`), await picture("png"));
        put(path.join(artists, `${P}_c.jpg`), olderJpeg);
        put(path.join(artists, `${P}_c_w300.jpg`), await picture("jpeg"));

        await repairCoverFormatsOnce({});

        expect(fs.readdirSync(artists)).toEqual([`${P}_c.jpg`]);
        expect(await formatOf(path.join(artists, `${P}_c.jpg`))).toBe("jpeg");
        expect(fs.readFileSync(path.join(artists, `${P}_c.jpg`)).equals(olderJpeg)).toBe(false);
        expect(await hero("c")).toBe(`native:artists/${P}_c.jpg?v=${await versionOfFile(path.join(artists, `${P}_c.jpg`))}`);
    });

    it("is removed when no row points at it and the artist's .jpg stands; the .jpg is left as it is", async () => {
        const jpeg = await picture("jpeg");
        put(path.join(artists, `${P}_d.png`), await picture("png"));
        put(path.join(artists, `${P}_d.jpg`), jpeg);

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ artistPicturesConverted: 0, failed: 0 });
        expect(fs.readdirSync(artists)).toEqual([`${P}_d.jpg`]);
        expect(fs.readFileSync(path.join(artists, `${P}_d.jpg`)).equals(jpeg)).toBe(true);
    });

    it("is left alone when no row points at it and there is no .jpg", async () => {
        put(path.join(artists, `${P}_e.png`), await picture("png"));

        await repairCoverFormatsOnce({});

        expect(fs.readdirSync(artists)).toEqual([`${P}_e.png`]);
    });

    it("is left, with its row, when it is no picture, and logged", async () => {
        await artist("f", `native:artists/${P}_f.png`);
        put(path.join(artists, `${P}_f.png`), Buffer.alloc(2000, 7));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ artistPicturesConverted: 0, notPictures: 1 });
        expect(fs.readdirSync(artists)).toEqual([`${P}_f.png`]);
        expect(await hero("f")).toBe(`native:artists/${P}_f.png`);
        expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes(`${P}_f.png`))).toBe(true);
    });

    it("is skipped when it is over the 20 MB cap, unread, and logged", async () => {
        await artist("g", `native:artists/${P}_g.png`);
        const huge = path.join(artists, `${P}_g.png`);
        put(huge, Buffer.alloc(0));
        fs.truncateSync(huge, 20 * 1024 * 1024 + 1);
        const read = jest.spyOn(fs.promises, "readFile");

        await repairCoverFormatsOnce({});

        expect(read.mock.calls.some((c) => String(c[0]).endsWith(`${P}_g.png`))).toBe(false);
        expect(await hero("g")).toBe(`native:artists/${P}_g.png`);
        expect(fs.existsSync(huge)).toBe(true);
        expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes(`${P}_g.png`))).toBe(true);
    });

    it("is not followed through a symbolic link", async () => {
        await artist("h", `native:artists/${P}_h.png`);
        put(path.join(ROOT, "elsewhere", "pic.png"), await picture("png"));
        fs.mkdirSync(artists, { recursive: true });
        fs.symlinkSync(path.join(ROOT, "elsewhere", "pic.png"), path.join(artists, `${P}_h.png`));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ artistPicturesConverted: 0, failed: 0 });
        expect(fs.existsSync(path.join(artists, `${P}_h.jpg`))).toBe(false);
        expect(await hero("h")).toBe(`native:artists/${P}_h.png`);
    });

    it("leaves the row and the old file when the write fails, and tries again on the next start", async () => {
        await artist("i", `native:artists/${P}_i.png`);
        put(path.join(artists, `${P}_i.png`), await picture("png"));
        jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("read-only"));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ artistPicturesConverted: 0, failed: 1 });
        expect(fs.readdirSync(artists)).toEqual([`${P}_i.png`]);
        expect(await hero("i")).toBe(`native:artists/${P}_i.png`);
        expect(await marker()).toBeNull();

        jest.restoreAllMocks();
        expect(await repairCoverFormatsOnce({})).toMatchObject({ artistPicturesConverted: 1, failed: 0 });
        expect(await hero("i")).toBe(`native:artists/${P}_i.jpg?v=${await versionOfFile(path.join(artists, `${P}_i.jpg`))}`);
        expect(await marker()).not.toBeNull();
    });

    it("finishes a conversion that stopped after the row moved, the next start removing the old file", async () => {
        await artist("j", `native:artists/${P}_j.jpg`);
        put(path.join(artists, `${P}_j.png`), await picture("png"));
        put(path.join(artists, `${P}_j.jpg`), await picture("jpeg"));

        await repairCoverFormatsOnce({});

        expect(fs.readdirSync(artists)).toEqual([`${P}_j.jpg`]);
    });

    it("does not stop the pass for other covers, which are still converted", async () => {
        await artist("k", `native:artists/${P}_k.png`);
        put(path.join(artists, `${P}_k.png`), await picture("png"));
        put(path.join(covers, "albums", "x.jpg"), await picture("png"));

        const result = await repairCoverFormatsOnce({});

        expect(result).toMatchObject({ artistPicturesConverted: 1, converted: 1, failed: 0 });
    });

    it("stops between files at a shutdown, without marking the pass done", async () => {
        for (const n of ["l1", "l2", "l3"]) {
            await artist(n, `native:artists/${P}_${n}.png`);
            put(path.join(artists, `${P}_${n}.png`), await picture("png"));
        }
        let asked = 0;

        const result = await repairCoverFormatsOnce({ shouldStop: () => ++asked > 1 });

        expect(result).toMatchObject({ stopped: true });
        expect(result!.artistPicturesConverted).toBeLessThan(3);
        expect(await marker()).toBeNull();
    });
});
