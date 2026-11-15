/**
 * The bitrate a scan stores for a song: the file's own, read from its headers (bits a second), kept in kbps; none
 * when the file reports none. A changed file is read again and its bitrate follows. Real scanner, temp folder and
 * test database; stand-in tags.
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
import { MusicScannerService } from "../musicScanner";

jest.setTimeout(60_000);

const P = "Scanbr";
const ARTIST = `${P} Artist`;
const ALBUM = `${P} Album`;

let musicDir: string;
/** What each file's headers report, by absolute path. */
const reported = new Map<string, number | undefined>();

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "albumId" IN (SELECT a.id FROM "Album" a JOIN "Artist" ar ON ar.id = a."artistId" WHERE ar.name LIKE $1)`, `${P}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE $1)`, `${P}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name LIKE $1`, `${P}%`);
}

function put(name: string, bitrate: number | undefined): string {
    const file = path.join(musicDir, "album", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `dummy audio ${name} ${Math.random()}`);
    reported.set(file, bitrate);
    return file;
}

const bitrateOf = async (rel: string) => (await prisma.track.findUniqueOrThrow({ where: { filePath: path.join("album", rel) } })).bitrate;

beforeEach(async () => {
    await wipe();
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanbr-"));
    reported.clear();
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => ({
        common: { title: path.basename(file), artist: ARTIST, albumartist: ARTIST, album: ALBUM, track: { no: 1 }, disk: { no: 1 }, year: 2024 },
        format: { duration: 180, codec: "MPEG 1 Layer 3", bitrate: reported.get(file) },
        native: {},
    }));
});

afterEach(() => {
    fs.rmSync(musicDir, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("a scan's stored bitrate", () => {
    it("keeps the file's own bitrate in kbps, rounded", async () => {
        put("320.mp3", 320000);
        put("vbr.mp3", 231_456);
        put("lossless.mp3", 987_654);

        await new MusicScannerService().scanLibrary(musicDir);

        expect(await bitrateOf("320.mp3")).toBe(320);
        expect(await bitrateOf("vbr.mp3")).toBe(231);
        expect(await bitrateOf("lossless.mp3")).toBe(988);
    });

    it("stores none for a file that reports no bitrate, never a made-up one", async () => {
        put("none.mp3", undefined);
        put("zero.mp3", 0);
        put("tiny.mp3", 300);
        put("nan.mp3", NaN);

        await new MusicScannerService().scanLibrary(musicDir);

        expect(await bitrateOf("none.mp3")).toBeNull();
        expect(await bitrateOf("zero.mp3")).toBeNull();
        // Under 500 bits a second would round to 0 kbps, which is no bitrate.
        expect(await bitrateOf("tiny.mp3")).toBeNull();
        expect(await bitrateOf("nan.mp3")).toBeNull();
    });

    it("follows a changed file, and clears it when the changed file reports none", async () => {
        const file = put("changing.mp3", 128000);
        await new MusicScannerService().scanLibrary(musicDir);
        expect(await bitrateOf("changing.mp3")).toBe(128);

        const later = new Date(Date.now() + 60_000);
        reported.set(file, 256000);
        fs.utimesSync(file, later, later);
        await new MusicScannerService().scanLibrary(musicDir);
        expect(await bitrateOf("changing.mp3")).toBe(256);

        const evenLater = new Date(Date.now() + 120_000);
        reported.set(file, undefined);
        fs.utimesSync(file, evenLater, evenLater);
        await new MusicScannerService().scanLibrary(musicDir);
        expect(await bitrateOf("changing.mp3")).toBeNull();
    });
});

describe("a scan filling the bitrate of songs read before it was kept", () => {
    const forget = (rel: string) => prisma.track.update({ where: { filePath: path.join("album", rel) }, data: { bitrate: null } });
    const stageOf = async (rel: string) => {
        const track = await prisma.track.findUniqueOrThrow({ where: { filePath: path.join("album", rel) } });
        return { track, stage: await prisma.trackStage.findUnique({ where: { trackId_stage: { trackId: track.id, stage: "analysis" } } }) };
    };

    it("fills an unchanged song on the next scan, without filing it again or reopening its stages", async () => {
        put("old.mp3", 192000);
        await new MusicScannerService().scanLibrary(musicDir);
        await forget("old.mp3");
        const before = await stageOf("old.mp3");
        await prisma.trackStage.upsert({
            where: { trackId_stage: { trackId: before.track.id, stage: "analysis" } },
            create: { trackId: before.track.id, stage: "analysis", status: "done" },
            update: { status: "done" },
        });

        const result = await new MusicScannerService().scanLibrary(musicDir);

        expect(result.tracksUpdated).toBe(0);
        expect(await bitrateOf("old.mp3")).toBe(192);
        const after = await stageOf("old.mp3");
        expect(after.stage?.status).toBe("done");
        expect(after.track.fileModified).toEqual(before.track.fileModified);
    });

    it("fills it too when a song added to its album makes the scan read the album", async () => {
        put("one.mp3", 160000);
        await new MusicScannerService().scanLibrary(musicDir);
        await forget("one.mp3");
        put("two.mp3", 96000);

        await new MusicScannerService().scanLibrary(musicDir);

        expect(await bitrateOf("one.mp3")).toBe(160);
        expect(await bitrateOf("two.mp3")).toBe(96);
    });

    it("leaves a song that reports no bitrate empty, and one that cannot be read as it was", async () => {
        const quiet = put("quiet.mp3", undefined);
        put("fine.mp3", 128000);
        const broken = put("broken.mp3", 128000);
        await new MusicScannerService().scanLibrary(musicDir);
        await forget("broken.mp3");
        (parseFile as jest.Mock).mockImplementation(async (file: string) => {
            if (file === broken) throw new Error("unreadable");
            return {
                common: { title: path.basename(file), artist: ARTIST, albumartist: ARTIST, album: ALBUM, track: { no: 1 }, disk: { no: 1 }, year: 2024 },
                format: { duration: 180, codec: "MPEG 1 Layer 3", bitrate: reported.get(file) },
                native: {},
            };
        });

        const result = await new MusicScannerService().scanLibrary(musicDir);

        expect(reported.get(quiet)).toBeUndefined();
        expect(await bitrateOf("quiet.mp3")).toBeNull();
        expect(await bitrateOf("fine.mp3")).toBe(128);
        expect(await bitrateOf("broken.mp3")).toBeNull();
        expect(result.tracksCorrupt).toBe(0);
        expect((await prisma.track.findUniqueOrThrow({ where: { filePath: path.join("album", "broken.mp3") } })).corrupt).toBe(false);
    });
});
