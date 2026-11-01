jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../services/featureDetection", () => require("./helpers/scannerMocks").featureDetectionMock());
jest.mock("../../services/acoustidService", () => require("./helpers/scannerMocks").acoustidServiceMock());
jest.mock("../../services/fpcalc", () => require("./helpers/scannerMocks").fpcalcMock());
jest.mock("../../services/coverArtExtractor", () => require("./helpers/scannerMocks").coverArtExtractorMock());
jest.mock("../../services/artwork", () => require("./helpers/scannerMocks").artworkMock());
jest.mock("../../services/artistCountsService", () => ({ ...require("./helpers/scannerMocks").artistCountsServiceMock(), updateArtistCounts: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../../services/imageStorage", () => require("./helpers/scannerMocks").imageStorageMock());
jest.mock("../../routes/library/trackPath", () => ({
    ...jest.requireActual("../../routes/library/trackPath"),
    resolveWithinMusicRoot: (...s: string[]) => require("path").resolve(process.env.CAND_MUSIC_DIR as string, ...s),
}));

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { MusicScannerService } from "../musicScanner";
import { clearOrphanedDiscoverAlbums } from "../discovery/discoverClearing";
import { useLidarr } from "../../__tests__/helpers/lidarrSettings";

jest.setTimeout(60_000);

/**
 * A listener's own copy of an album Discover once downloaded is theirs. Last week's Discover downloads were cleared when
 * this week began, but their finished download records stay for 30 days; the listener then puts their own copy of each
 * album in the music folder (not through a Kima request). And a Discover album cleared this week takes its download
 * record with it, so a copy added afterwards is theirs too.
 */
const P = "cand";
const USER = `${P}_user`;
const NAMES = ["One", "Two", "Three"].map((n) => ({ artist: `Cand Artist ${n}`, album: `Cand Album ${n}` }));
const CLEARED = { artist: "Cand Artist Four", album: "Cand Album Four" };
let currentBatch: string;
let musicDir: string;
const files = new Map<string, { artist: string; album: string; no: number }>();

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE 'Cand %')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "albumId" IN (SELECT a.id FROM "Album" a JOIN "Artist" ar ON ar.id = a."artistId" WHERE ar.name LIKE 'Cand %')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE 'Cand %')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name LIKE 'Cand %'`);
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(async () => {
    await wipe();
    await useLidarr("", { lidarrEnabled: false });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    const batch = await prisma.discoveryBatch.create({
        data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 10, status: "completed", createdAt: new Date(Date.now() - 9 * 86400_000) },
    });
    currentBatch = (
        await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 26)), targetSongCount: 10, status: "completed", createdAt: new Date(Date.now() - 2 * 86400_000) },
        })
    ).id;
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400_000);
    for (const n of NAMES) {
        await prisma.downloadJob.create({
            data: {
                userId: USER, subject: `${n.artist} - ${n.album}`, type: "album", status: "completed", completedAt: fiveDaysAgo,
                discoveryBatchId: batch.id,
                metadata: { downloadType: "discovery", currentSource: "soulseek", artistName: n.artist, albumTitle: n.album },
            },
        });
    }
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), `${P}-`));
    process.env.CAND_MUSIC_DIR = musicDir;
    for (const n of NAMES) {
        for (const no of [1, 2]) {
            const file = path.join(musicDir, n.artist, n.album, `0${no}.flac`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `x ${n.album} ${no}`);
            files.set(file, { ...n, no });
        }
    }
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => {
        const f = files.get(file)!;
        return {
            common: { title: `Song ${f.no}`, artist: f.artist, albumartist: f.artist, album: f.album, track: { no: f.no }, disk: { no: 1 }, year: 2024 },
            format: { duration: 180, codec: "flac" },
            native: {},
        };
    });
});
afterAll(async () => {
    fs.rmSync(musicDir, { recursive: true, force: true });
    await wipe();
    await prisma.$disconnect();
});

function writeAlbum(n: { artist: string; album: string }) {
    for (const no of [1, 2]) {
        const file = path.join(musicDir, n.artist, n.album, `0${no}.flac`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `x ${n.album} ${no}`);
        files.set(file, { ...n, no });
    }
}
const locationOf = async (title: string) => (await prisma.album.findFirst({ where: { title }, select: { location: true } }))?.location;

describe("a listener's own copy of an album Discover once downloaded", () => {
    it("is filed in the library when the download was an earlier week's", async () => {
        await new MusicScannerService().scanLibrary(musicDir);
        const rows = await prisma.album.findMany({ where: { artist: { name: { startsWith: "Cand " } } }, select: { location: true } });
        expect(rows.map((r) => r.location)).toEqual(["LIBRARY", "LIBRARY", "LIBRARY"]);
    });

    it("keeps its files through the weekly clear", async () => {
        await clearOrphanedDiscoverAlbums();
        expect([...files.keys()].filter((f) => fs.existsSync(f))).toHaveLength(6);
    });

    it("is filed in the library when this week's Discover copy was cleared before it arrived", async () => {
        await prisma.downloadJob.create({
            data: {
                userId: USER, subject: `${CLEARED.artist} - ${CLEARED.album}`, type: "album", status: "completed", completedAt: new Date(),
                discoveryBatchId: currentBatch,
                metadata: { downloadType: "discovery", currentSource: "soulseek", artistName: CLEARED.artist, albumTitle: CLEARED.album },
            },
        });
        writeAlbum(CLEARED);
        await new MusicScannerService().scanLibrary(musicDir);
        expect(await locationOf(CLEARED.album)).toBe("DISCOVER");

        // No suggestion covers it, so the weekly clear removes Discover's copy, and its download record goes with it.
        const { cleared } = await clearOrphanedDiscoverAlbums();
        expect(cleared).toBe(1);
        expect(await prisma.downloadJob.count({ where: { subject: `${CLEARED.artist} - ${CLEARED.album}` } })).toBe(0);

        writeAlbum(CLEARED);
        await new MusicScannerService().scanLibrary(musicDir);
        expect(await locationOf(CLEARED.album)).toBe("LIBRARY");
    });
});
