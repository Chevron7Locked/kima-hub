/**
 * What a scan reports of the library a client lists (`libraryChanged`, read by workers/processors/scanProcessor.ts to move
 * the library-changed marker): true only when a song on a library album was added, changed, flagged missing, brought
 * back, flagged corrupt or retired. A scan that only filed or flagged Discover songs, found nothing to change, or failed
 * before filing anything reports false; one that fails after filing a library song keeps true on the scanner, since
 * its counts are lost with the throw. Real scanner, temp folder and test database; stand-in tags.
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
import * as reconcile from "../libraryReconcile";

jest.setTimeout(60_000);

const P = "Scanchg";
const USER = "scanchg_user";
const LIB = { artist: `${P} Lib Artist`, album: `${P} Lib Album`, rel: path.join("lib", "01.flac") };
const DIS = { artist: `${P} Dis Artist`, album: `${P} Dis Album`, rel: path.join("dis", "01.flac") };

let musicDir: string;
const tags = new Map<string, { artist: string; album: string }>();

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "RemovalLog" WHERE "filePath" IN ($1, $2)`, LIB.rel, DIS.rel);
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE $1)`, `${P}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "albumId" IN (SELECT a.id FROM "Album" a JOIN "Artist" ar ON ar.id = a."artistId" WHERE ar.name LIKE $1)`, `${P}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE $1)`, `${P}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name LIKE $1`, `${P}%`);
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

function put(song: typeof LIB): string {
    const file = path.join(musicDir, song.rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `dummy audio ${song.rel} ${Math.random()}`);
    tags.set(file, { artist: song.artist, album: song.album });
    return file;
}

beforeEach(async () => {
    await wipe();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    // A Discover download asked for the Dis album, so a scan files it as Discover's.
    const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 10 } });
    await prisma.downloadJob.create({
        data: {
            userId: USER, subject: `${DIS.artist} - ${DIS.album}`, type: "album", status: "completed", discoveryBatchId: batch.id,
            metadata: { downloadType: "discovery", artistName: DIS.artist, albumTitle: DIS.album },
        },
    });
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanchg-"));
    tags.clear();
    // Flag mode unless a test says otherwise, so a vanished file is flagged and nothing is retired.
    jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "flag" });
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => {
        const t = tags.get(file)!;
        return {
            common: { title: "Song", artist: t.artist, albumartist: t.artist, album: t.album, track: { no: 1 }, disk: { no: 1 }, year: 2024 },
            format: { duration: 180, codec: "flac" },
            native: {},
        };
    });
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(musicDir, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("a scan's libraryChanged", () => {
    it("is true when a song is added to a library album, false when a Discover song is", async () => {
        put(DIS);
        const discoverOnly = await new MusicScannerService().scanLibrary(musicDir);
        expect(discoverOnly.tracksAdded).toBe(1);
        expect(discoverOnly.libraryChanged).toBe(false);
        expect((await prisma.album.findFirstOrThrow({ where: { title: DIS.album } })).location).toBe("DISCOVER");

        put(LIB);
        const withLibrary = await new MusicScannerService().scanLibrary(musicDir);
        expect(withLibrary.tracksAdded).toBe(1);
        expect(withLibrary.libraryChanged).toBe(true);
    });

    it("is false when nothing changed", async () => {
        put(LIB);
        put(DIS);
        await new MusicScannerService().scanLibrary(musicDir);
        expect((await new MusicScannerService().scanLibrary(musicDir)).libraryChanged).toBe(false);
    });

    it("is true when a library song's file changes, false for a Discover song's", async () => {
        const lib = put(LIB);
        const dis = put(DIS);
        await new MusicScannerService().scanLibrary(musicDir);
        const later = new Date(Date.now() + 60_000);

        fs.utimesSync(dis, later, later);
        const discover = await new MusicScannerService().scanLibrary(musicDir);
        expect(discover.tracksUpdated).toBe(1);
        expect(discover.libraryChanged).toBe(false);

        fs.utimesSync(lib, later, later);
        const library = await new MusicScannerService().scanLibrary(musicDir);
        expect(library.tracksUpdated).toBe(1);
        expect(library.libraryChanged).toBe(true);
    });

    it("is true when a library song's file goes missing and when it comes back, false for a Discover song's", async () => {
        const lib = put(LIB);
        const dis = put(DIS);
        await new MusicScannerService().scanLibrary(musicDir);

        fs.unlinkSync(dis);
        const discoverGone = await new MusicScannerService().scanLibrary(musicDir);
        expect(discoverGone.tracksMissing).toBe(1);
        expect(discoverGone.libraryChanged).toBe(false);

        fs.unlinkSync(lib);
        const libraryGone = await new MusicScannerService().scanLibrary(musicDir);
        expect(libraryGone.tracksMissing).toBe(1);
        expect(libraryGone.libraryChanged).toBe(true);

        put(LIB);
        const back = await new MusicScannerService().scanLibrary(musicDir);
        expect(back.libraryChanged).toBe(true);
    });

    it("is false when songs already flagged missing are retired, because the flag was the change a client listed", async () => {
        jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
        const lib = put(LIB);
        const dis = put(DIS);
        await new MusicScannerService().scanLibrary(musicDir);

        fs.unlinkSync(dis);
        await new MusicScannerService().scanLibrary(musicDir);
        const discoverRetired = await new MusicScannerService().scanLibrary(musicDir);
        expect(discoverRetired.tracksRemoved).toBe(1);
        expect(discoverRetired.libraryChanged).toBe(false);

        fs.unlinkSync(lib);
        const flagged = await new MusicScannerService().scanLibrary(musicDir);
        expect(flagged.libraryChanged).toBe(true);
        const libraryRetired = await new MusicScannerService().scanLibrary(musicDir);
        expect(libraryRetired.tracksRemoved).toBe(1);
        expect(libraryRetired.libraryChanged).toBe(false);
    });

    it("is true when a library song is flagged corrupt, false for a Discover song", async () => {
        const lib = put(LIB);
        const dis = put(DIS);
        await new MusicScannerService().scanLibrary(musicDir);
        const later = new Date(Date.now() + 60_000);
        (parseFile as jest.Mock).mockRejectedValue(new Error("unreadable"));

        fs.utimesSync(dis, later, later);
        const discover = await new MusicScannerService().scanLibrary(musicDir);
        expect(discover.tracksCorrupt).toBe(1);
        expect(discover.libraryChanged).toBe(false);

        fs.utimesSync(lib, later, later);
        const library = await new MusicScannerService().scanLibrary(musicDir);
        // The corrupt Discover file is read again too: a corrupt file is retried on every scan.
        expect(library.tracksCorrupt).toBe(2);
        expect(library.libraryChanged).toBe(true);
    });

    it("is false when a library song that is already flagged corrupt fails to read again", async () => {
        const lib = put(LIB);
        await new MusicScannerService().scanLibrary(musicDir);
        (parseFile as jest.Mock).mockRejectedValue(new Error("unreadable"));
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(lib, later, later);
        expect((await new MusicScannerService().scanLibrary(musicDir)).libraryChanged).toBe(true);

        const again = await new MusicScannerService().scanLibrary(musicDir);
        expect(again.tracksCorrupt).toBe(1);
        expect(again.libraryChanged).toBe(false);
    });
});

describe("a scan's libraryChanged for a song flagged missing", () => {
    it("is false when its file is back but still cannot be read, since the song is no more listed than it was", async () => {
        const lib = put(LIB);
        await new MusicScannerService().scanLibrary(musicDir);
        fs.unlinkSync(lib);
        expect((await new MusicScannerService().scanLibrary(musicDir)).tracksMissing).toBe(1);

        put(LIB);
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(lib, later, later);
        (parseFile as jest.Mock).mockRejectedValue(new Error("unreadable"));
        const scan = await new MusicScannerService().scanLibrary(musicDir);

        expect(scan.tracksCorrupt).toBe(1);
        const song = await prisma.track.findFirstOrThrow({ where: { filePath: LIB.rel } });
        expect(song.corrupt).toBe(true);
        expect(scan.libraryChanged).toBe(false);
    });
});

describe("a scan that fails", () => {
    it("before filing anything has changed no library song", async () => {
        const lib = put(LIB);
        await new MusicScannerService().scanLibrary(musicDir);
        // A music folder with nothing in it, over a library that holds songs: a drive not mounted.
        fs.unlinkSync(lib);
        fs.rmSync(path.dirname(lib), { recursive: true });
        const scanner = new MusicScannerService();

        await expect(scanner.scanLibrary(musicDir)).rejects.toThrow("is empty");

        expect(scanner.libraryChanged).toBe(false);
    });

    it("after filing a library song has changed the library", async () => {
        put(LIB);
        jest.spyOn(reconcile, "runReconcile").mockRejectedValue(new Error("reconcile broke"));
        const scanner = new MusicScannerService();

        await expect(scanner.scanLibrary(musicDir)).rejects.toThrow("reconcile broke");

        expect(scanner.libraryChanged).toBe(true);
    });

    it("after filing only a Discover song has not", async () => {
        put(DIS);
        jest.spyOn(reconcile, "runReconcile").mockRejectedValue(new Error("reconcile broke"));
        const scanner = new MusicScannerService();

        await expect(scanner.scanLibrary(musicDir)).rejects.toThrow("reconcile broke");

        expect(scanner.libraryChanged).toBe(false);
    });
});
