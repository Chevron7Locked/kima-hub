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
 * Which album a scan files as Discover: only one a Discover download asked for exactly (by release-group id, or exactly
 * its artist and title) or a current Discover suggestion, unless the listener liked it or asked for it themselves. A title shared with another
 * artist's Discover album, or an artist Discover once suggested, is the listener's own album. Real test database and
 * scanner; the audio is a stand-in file whose tags the parser reports.
 */
const P = "scanfile";
const USER = `${P}_user`;
const RG = {
    jobbyid: "5cf10000-0000-4000-8000-0000000000a1",
    jobbyidAsked: "5cf10000-0000-4000-8000-0000000000a1",
};

interface Album {
    key: string;
    artist: string;
    album: string;
    rg?: string;
    expect: "DISCOVER" | "LIBRARY";
}
const ALBUMS: Album[] = [
    // A Discover download asked for exactly this album.
    { key: "exact", artist: "Scanfile Dynatron", album: "Scanfile Origins", expect: "DISCOVER" },
    // The same title by another artist: the listener's own album (a title match alone must not file it as Discover).
    { key: "sametitle", artist: "Scanfile Danger", album: "Scanfile Origins", expect: "LIBRARY" },
    // A Discover download asked for it by id; the files carry a different title.
    { key: "byid", artist: "Scanfile Byid", album: "Scanfile Retitled", rg: RG.jobbyid, expect: "DISCOVER" },
    // An artist Discover once suggested (and the listener rejected): their own download of another album.
    { key: "oncesuggested", artist: "Scanfile Artificial", album: "Scanfile The Observer", expect: "LIBRARY" },
    // A current suggestion with no Discover download: a suggestion alone does not make an album Discover's.
    { key: "current", artist: "Scanfile Current", album: "Scanfile This Week", expect: "LIBRARY" },
    // A Discover album the listener liked.
    { key: "liked", artist: "Scanfile Liked", album: "Scanfile Kept", expect: "LIBRARY" },
    // An album the listener let go as a suggestion, then got themselves: theirs.
    { key: "rejected", artist: "Scanfile Rejected", album: "Scanfile Let Go", expect: "LIBRARY" },
    // An album the listener asked for themselves that Discover had also suggested.
    { key: "requested", artist: "Scanfile Requested", album: "Scanfile Asked For", expect: "LIBRARY" },
    // Names in another script are compared as names, not folded to nothing: no match with a Discover album in
    // another script.
    { key: "script", artist: "Кино", album: "Звезда", expect: "LIBRARY" },
];

let musicDir: string;
const files = new Map<string, Album & { no: number }>();

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE $1)`, "Scanfile%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "albumId" IN (SELECT a.id FROM "Album" a JOIN "Artist" ar ON ar.id = a."artistId" WHERE ar.name LIKE $1)`, "Scanfile%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE $1)`, "Scanfile%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name LIKE $1`, "Scanfile%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "albumId" IN (SELECT a.id FROM "Album" a JOIN "Artist" ar ON ar.id = a."artistId" WHERE ar.name = 'Кино')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name = 'Кино')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name = 'Кино')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = 'Кино'`);
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(async () => {
    await wipe();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 10 } });
    const job = (subject: string, targetMbid: string | null, artistName: string, albumTitle: string) =>
        prisma.downloadJob.create({
            data: {
                userId: USER,
                subject,
                type: "album",
                status: "completed",
                targetMbid,
                discoveryBatchId: batch.id,
                metadata: { downloadType: "discovery", artistName, albumTitle },
            },
        });
    await job("Scanfile Dynatron - Scanfile Origins", null, "Scanfile Dynatron", "Scanfile Origins");
    await job("Scanfile Byid - Scanfile Asked Title", RG.jobbyidAsked, "Scanfile Byid", "Scanfile Asked Title");
    const suggestion = (artistName: string, albumTitle: string, status: "ACTIVE" | "LIKED" | "DELETED", rg: string) =>
        prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: rg, artistName, albumTitle, weekStartDate: new Date(Date.UTC(2026, 9, 19)), status },
        });
    await suggestion("Scanfile Artificial", "Scanfile Now We Sleep", "DELETED", `${P}-rg-a`);
    await suggestion("Scanfile Current", "Scanfile This Week", "ACTIVE", `${P}-rg-c`);
    await suggestion("Scanfile Liked", "Scanfile Kept", "LIKED", `${P}-rg-l`);
    await suggestion("Scanfile Rejected", "Scanfile Let Go", "DELETED", `${P}-rg-r`);
    await suggestion("Scanfile Requested", "Scanfile Asked For", "DELETED", `${P}-rg-q`);
    await job("米津玄師 - 馬と鹿", null, "米津玄師", "馬と鹿");
    await prisma.downloadJob.create({
        data: {
            userId: USER,
            subject: "Scanfile Requested - Scanfile Asked For",
            type: "album",
            status: "completed",
            metadata: { downloadType: "library", artistName: "Scanfile Requested", albumTitle: "Scanfile Asked For" },
        },
    });
    // A Discover download for the liked album too: the like wins.
    await job("Scanfile Liked - Scanfile Kept", null, "Scanfile Liked", "Scanfile Kept");

    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), `${P}-`));
    for (const album of ALBUMS) {
        for (const no of [1, 2]) {
            const file = path.join(musicDir, album.artist, album.album, `0${no} - Song ${no}.flac`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `dummy audio ${album.key} ${no}`);
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
                ...(f.rg ? { musicbrainz_releasegroupid: f.rg } : {}),
            },
            format: { duration: 180, codec: "flac" },
            native: {},
        };
    });
    await new MusicScannerService().scanLibrary(musicDir);
});

afterAll(async () => {
    jest.restoreAllMocks();
    fs.rmSync(musicDir, { recursive: true, force: true });
    await wipe();
    await prisma.$disconnect();
});

describe("which album a scan files as Discover", () => {
    it.each(ALBUMS.map((a) => [a.key, a] as const))("%s", async (_key, album) => {
        const row = await prisma.album.findFirstOrThrow({ where: { title: album.album, artist: { name: album.artist } } });
        expect(row.location).toBe(album.expect);
    });
});
