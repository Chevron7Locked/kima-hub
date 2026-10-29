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

/**
 * A scan marks an album owned only when it is a library album. The Discover check ran only when a scan created the
 * album, so the album's other songs, and every later scan, marked a Discover album owned; the collection then listed
 * it as yours. Real test database, real scanner; the audio is a stand-in file whose tags the parser reports.
 */
const P = "scanown";
// Release-group ids in MusicBrainz form, as the scanner keeps only those.
const RG_DISC = "5ca70000-0000-4000-8000-0000000000d1";
const RG_LIB = "5ca70000-0000-4000-8000-0000000000a1";
const USER = `${P}_user`;
const ALBUMS = [
    { folder: path.join("Scanown Discover Artist", "Scanown Suggested"), artist: "Scanown Discover Artist", album: "Scanown Suggested", rg: RG_DISC },
    { folder: path.join("Scanown Library Artist", "Scanown Kept"), artist: "Scanown Library Artist", album: "Scanown Kept", rg: RG_LIB },
];

let musicDir: string;
const files = new Map<string, (typeof ALBUMS)[number] & { no: number }>();

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "rgMbid" = ANY($1)`, [RG_DISC, RG_LIB]);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "albumId" IN (SELECT id FROM "Album" WHERE "rgMbid" = ANY($1))`, [RG_DISC, RG_LIB]);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "rgMbid" = ANY($1)`, [RG_DISC, RG_LIB]);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name LIKE $1`, "Scanown%");
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeEach(async () => {
    await wipe();
    // What makes the first album Discover's: a Discover download asked for it (discoverEvidence).
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.downloadJob.create({
        data: {
            userId: USER,
            subject: "Scanown Discover Artist - Scanown Suggested",
            type: "album",
            targetMbid: RG_DISC,
            status: "completed",
            metadata: { downloadType: "discovery", artistName: "Scanown Discover Artist", albumTitle: "Scanown Suggested" },
        },
    });
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), `${P}-`));
    files.clear();
    for (const album of ALBUMS) {
        for (const no of [1, 2, 3]) {
            const file = path.join(musicDir, album.folder, `0${no} - Song ${no}.flac`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `dummy audio ${album.album} ${no}`);
            files.set(file, { ...album, no });
        }
    }
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => {
        const f = files.get(file)!;
        return {
            common: {
                title: `Song ${f.no}`,
                artist: f.artist,
                albumartist: f.artist,
                album: f.album,
                track: { no: f.no },
                disk: { no: 1 },
                year: 2024,
                musicbrainz_releasegroupid: f.rg,
            },
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

const owned = async (rg: string) => prisma.ownedAlbum.count({ where: { rgMbid: rg } });
const location = async (rg: string) => (await prisma.album.findUniqueOrThrow({ where: { rgMbid: rg } })).location;

describe("a scan marks only library albums owned", () => {
    it("never marks a Discover album owned, through any of its songs or on a later scan", async () => {
        const scanner = new MusicScannerService();
        expect((await scanner.scanLibrary(musicDir)).tracksAdded).toBe(6);
        expect(await location(RG_DISC)).toBe("DISCOVER");
        expect(await owned(RG_DISC)).toBe(0);

        // A later scan that reads the files again (they changed on disk).
        for (const file of files.keys()) fs.utimesSync(file, new Date(), new Date(Date.now() + 60_000));
        await scanner.scanLibrary(musicDir);
        expect(await owned(RG_DISC)).toBe(0);
    });

    it("marks a library album owned", async () => {
        await new MusicScannerService().scanLibrary(musicDir);
        expect(await location(RG_LIB)).toBe("LIBRARY");
        expect(await owned(RG_LIB)).toBe(1);
    });
});
