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
        put("flac.mp3", 987_654);

        await new MusicScannerService().scanLibrary(musicDir);

        expect(await bitrateOf("320.mp3")).toBe(320);
        expect(await bitrateOf("vbr.mp3")).toBe(231);
        expect(await bitrateOf("flac.mp3")).toBe(988);
    });

    it("stores none for a file that reports no bitrate, never a made-up one", async () => {
        put("none.mp3", undefined);
        put("zero.mp3", 0);

        await new MusicScannerService().scanLibrary(musicDir);

        expect(await bitrateOf("none.mp3")).toBeNull();
        expect(await bitrateOf("zero.mp3")).toBeNull();
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
