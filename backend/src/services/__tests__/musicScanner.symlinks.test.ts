/**
 * Links in the music folder: a linked song or folder is scanned where the link stands, one real file is one song
 * however many paths reach it, a loop ends, and a link with nothing behind it goes the way of any missing file.
 * Real scanner, real links in temp directories, test database.
 */

jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../services/featureDetection", () => require("./helpers/scannerMocks").featureDetectionMock());
jest.mock("../../services/acoustidService", () => require("./helpers/scannerMocks").acoustidServiceMock());
jest.mock("../../services/fpcalc", () => require("./helpers/scannerMocks").fpcalcMock());
jest.mock("../../services/coverArtExtractor", () => require("./helpers/scannerMocks").coverArtExtractorMock());
jest.mock("../../services/artwork", () => require("./helpers/scannerMocks").artworkMock());
jest.mock("../../services/artistCountsService", () => require("./helpers/scannerMocks").artistCountsServiceMock());
jest.mock("../../services/imageStorage", () => require("./helpers/scannerMocks").imageStorageMock());

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { MusicScannerService } from "../musicScanner";
import { isBehindLinkOut } from "../../routes/library/trackPath";

jest.setTimeout(60_000);

const ARTIST = "Symlink Scan Artist";
let root: string;
let music: string;
let outside: string;

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "RemovalLog" WHERE "artistName" = $1`, ARTIST);
    await prisma.$executeRawUnsafe(
        `DELETE FROM "Track" WHERE "albumId" IN (SELECT a.id FROM "Album" a JOIN "Artist" ar ON ar.id = a."artistId" WHERE ar.name = $1)`,
        ARTIST,
    );
    await prisma.$executeRawUnsafe(
        `DELETE FROM "Album" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name = $1)`,
        ARTIST,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = $1`, ARTIST);
}

/** A file with bytes, so the scanner does not take it for an unfinished download. */
function song(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "dummy audio bytes");
    return file;
}

function link(target: string, at: string): void {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at);
}

async function storedPaths(): Promise<string[]> {
    const rows = await prisma.track.findMany({
        where: { album: { artist: { name: ARTIST } } },
        select: { filePath: true },
    });
    return rows.map((r) => r.filePath).sort();
}

async function missingPaths(): Promise<string[]> {
    const rows = await prisma.track.findMany({
        where: { album: { artist: { name: ARTIST } }, missingSince: { not: null } },
        select: { filePath: true },
    });
    return rows.map((r) => r.filePath).sort();
}

function scan() {
    return new MusicScannerService().scanLibrary(music);
}

beforeEach(async () => {
    await wipe();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-scan-"));
    music = path.join(root, "music");
    outside = path.join(root, "elsewhere");
    fs.mkdirSync(music);
    fs.mkdirSync(outside);
    let next = 0;
    const numbers = new Map<string, number>();
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => {
        if (!numbers.has(file)) numbers.set(file, ++next);
        return {
            common: {
                title: path.basename(file, ".flac"), artist: ARTIST, albumartist: ARTIST, album: "Symlink Album",
                track: { no: numbers.get(file) }, disk: { no: 1 }, year: 2024,
            },
            format: { duration: 180, codec: "flac" },
            native: {},
        };
    });
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("links in the music folder", () => {
    it("scans a linked song and keeps the link's own path", async () => {
        link(song(path.join(outside, "one.flac")), path.join(music, "Album", "one.flac"));
        const result = await scan();
        expect(result.tracksAdded).toBe(1);
        expect(await storedPaths()).toEqual([path.join("Album", "one.flac")]);
    });

    it("scans a linked folder, and a link inside it", async () => {
        song(path.join(outside, "Album", "one.flac"));
        song(path.join(outside, "Other", "two.flac"));
        link(path.join(outside, "Other", "two.flac"), path.join(outside, "Album", "two.flac"));
        link(path.join(outside, "Album"), path.join(music, "Linked"));
        await scan();
        expect(await storedPaths()).toEqual([path.join("Linked", "one.flac"), path.join("Linked", "two.flac")]);
    });

    it("ignores a linked file that is not audio", async () => {
        const notes = path.join(outside, "notes.txt");
        fs.writeFileSync(notes, "words");
        link(notes, path.join(music, "notes.txt"));
        await scan();
        expect(await storedPaths()).toEqual([]);
    });

    it("keeps a real song and drops a link to it, whichever sorts first", async () => {
        const real = song(path.join(music, "z-real", "one.flac"));
        link(real, path.join(music, "a-link", "one.flac"));
        link(path.join(music, "z-real"), path.join(music, "a-folder-link"));
        await scan();
        expect(await storedPaths()).toEqual([path.join("z-real", "one.flac")]);
    });

    it("gives two links to one file one song, and a later link does not displace it", async () => {
        const real = song(path.join(outside, "one.flac"));
        link(real, path.join(music, "b", "one.flac"));
        link(real, path.join(music, "c", "one.flac"));
        await scan();
        expect(await storedPaths()).toEqual([path.join("b", "one.flac")]);

        link(real, path.join(music, "a", "one.flac"));
        await scan();
        expect(await storedPaths()).toEqual([path.join("b", "one.flac")]);
        expect(await missingPaths()).toEqual([]);
    });

    it("ends on a folder link back up its own tree, and on a link above the music folder", async () => {
        song(path.join(music, "Album", "one.flac"));
        link(music, path.join(music, "Album", "again"));
        song(path.join(outside, "not-library.flac"));
        link(root, path.join(music, "above"));
        await scan();
        expect(await storedPaths()).toEqual([path.join("Album", "one.flac")]);
    });

    it("finishes the scan past a broken link, a link to itself and an unreadable linked folder", async () => {
        song(path.join(music, "Album", "one.flac"));
        link(path.join(outside, "nothing.flac"), path.join(music, "broken.flac"));
        link(path.join(music, "self.flac"), path.join(music, "self.flac"));
        const locked = path.join(outside, "locked");
        fs.mkdirSync(locked);
        link(locked, path.join(music, "locked"));
        fs.chmodSync(locked, 0o000);
        try {
            const result = await scan();
            expect(result.errors).toEqual([]);
            expect(await storedPaths()).toEqual([path.join("Album", "one.flac")]);
        } finally {
            fs.chmodSync(locked, 0o755);
        }
    });

    it("retires songs behind a broken link like any missing file, and scans them again when the target returns", async () => {
        const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
        song(path.join(music, "Real", "zero.flac"));
        const share = path.join(outside, "share");
        song(path.join(share, "Album", "one.flac"));
        const single = song(path.join(outside, "two.flac"));
        link(share, path.join(music, "share"));
        link(single, path.join(music, "two.flac"));
        await scan();
        const linked = [path.join("share", "Album", "one.flac"), "two.flac"];
        const paths = [path.join("Real", "zero.flac"), ...linked].sort();
        expect(await storedPaths()).toEqual(paths);

        const parked = path.join(root, "parked");
        fs.renameSync(outside, parked);
        await scan();
        expect(await missingPaths()).toEqual(linked);
        await scan();
        expect(await storedPaths()).toEqual([path.join("Real", "zero.flac")]);

        fs.renameSync(parked, outside);
        await scan();
        expect(await storedPaths()).toEqual(paths);
        expect(await missingPaths()).toEqual([]);
        spy.mockRestore();
    });

    it("flags a song deleted from a linked folder that is still there", async () => {
        const one = song(path.join(outside, "Album", "one.flac"));
        link(path.join(outside, "Album"), path.join(music, "Linked"));
        await scan();
        fs.unlinkSync(one);
        await scan();
        expect(await missingPaths()).toEqual([path.join("Linked", "one.flac")]);
    });

    it("never deletes through a linked folder that leads out of the music folder", () => {
        const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, musicPath: music });
        song(path.join(outside, "Album", "one.flac"));
        link(path.join(outside, "Album"), path.join(music, "Linked"));
        link(song(path.join(outside, "two.flac")), path.join(music, "two.flac"));
        song(path.join(music, "Real", "three.flac"));
        link(path.join(music, "Real"), path.join(music, "Again"));

        expect(isBehindLinkOut(path.join("Linked", "one.flac"))).toBe(true);
        // A linked song goes as a link, and a link inside the library stays inside it.
        expect(isBehindLinkOut("two.flac")).toBe(false);
        expect(isBehindLinkOut(path.join("Real", "three.flac"))).toBe(false);
        expect(isBehindLinkOut(path.join("Again", "three.flac"))).toBe(false);
        expect(isBehindLinkOut(path.join("Gone", "four.flac"))).toBe(false);
        spy.mockRestore();
    });
});
