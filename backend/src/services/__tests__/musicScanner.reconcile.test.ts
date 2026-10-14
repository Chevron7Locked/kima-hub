/**
 * The scanner in delete-after-grace mode: the full scanLibrary path, not the service
 * called in isolation. Proves the three things the plan asked of Task 3 and the suite
 * previously left unproven — Step 4b runs (result.tracksRemoved is the scanner's own
 * count), it runs BEFORE Steps 5-6 so the emptied album and artist cascade free, and
 * `flag` mode (config unchanged) deletes nothing across the same three scans.
 * Real scanner, temp directory, test database.
 */

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({
            musicCNN: false, vibeEmbeddings: false, audiobookshelfEnabled: false, fpcalc: false,
        }),
    },
}));
jest.mock("../../services/acoustidService", () => ({ acoustidService: { lookup: jest.fn().mockResolvedValue(null) } }));
jest.mock("../../services/fpcalc", () => ({
    fpcalcService: { isAvailable: jest.fn().mockResolvedValue(false), fingerprintFile: jest.fn().mockResolvedValue(null) },
}));
jest.mock("../../services/coverArtExtractor", () => ({ CoverArtExtractor: jest.fn().mockImplementation(() => ({})) }));
jest.mock("../../services/artwork", () => ({ findAlbumArtwork: jest.fn().mockResolvedValue(null) }));
jest.mock("../../services/artistCountsService", () => ({ backfillAllArtistCounts: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../../services/imageStorage", () => ({ findLocalArtistImage: jest.fn().mockResolvedValue(null) }));

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { MusicScannerService } from "../musicScanner";

jest.setTimeout(60_000);

const RG_MBID = "rg-recon-scan-1";
const REL = path.join("Artist", "Album", "01 - Retired.flac");

let musicDir: string;
let trackFile: string;

function writeFile(): void {
    fs.mkdirSync(path.dirname(trackFile), { recursive: true });
    fs.writeFileSync(trackFile, "dummy audio bytes");
}

function fakeMetadata() {
    return {
        common: { title: "Retired", artist: "Recon Scan Artist", albumartist: "Recon Scan Artist", album: "Recon Scan Album", track: { no: 1 }, disk: { no: 1 }, year: 2024, musicbrainz_releasegroupid: RG_MBID },
        format: { duration: 180, codec: "flac" },
        native: {},
    };
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "RemovalLog" WHERE "filePath" = $1`, REL);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "filePath" = $1`, REL);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "rgMbid" = $1`, RG_MBID);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = $1`, "Recon Scan Artist");
}

beforeEach(async () => {
    await wipe();
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-scan-"));
    trackFile = path.join(musicDir, REL);
    writeFile();
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockResolvedValue(fakeMetadata());
});

afterEach(() => {
    fs.rmSync(musicDir, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

async function backdate(): Promise<void> {
    await prisma.$executeRawUnsafe(
        `UPDATE "Track" SET "missingSince" = now() - interval '40 days' WHERE "filePath" = $1`, REL);
}

describe("scanLibrary in delete-after-grace mode", () => {
    it("retires the grace-crossed track, carries the count, and cascades the emptied album and artist in the same scan", async () => {
        const spy = jest.spyOn(config, "music", "get").mockReturnValue({
            ...config.music, reconcileMode: "delete-after-grace", reconcileGraceDays: 30,
        });
        try {
            const scanner = new MusicScannerService();
            const first = await scanner.scanLibrary(musicDir);
            expect(first.tracksAdded).toBe(1);
            expect(first.tracksRemoved).toBe(0);

            fs.unlinkSync(trackFile);
            const second = await scanner.scanLibrary(musicDir);
            expect(second.tracksMissing).toBe(1);
            expect(second.tracksRemoved).toBe(0);
            expect(await prisma.track.findUnique({ where: { filePath: REL } })).not.toBeNull();

            await backdate();
            const third = await scanner.scanLibrary(musicDir);

            // Step 4b ran, and the scanner reports its own count.
            expect(third.tracksRemoved).toBe(1);
            expect(await prisma.track.findUnique({ where: { filePath: REL } })).toBeNull();

            // The audit row carries the snapshot the row no longer holds.
            const log = await prisma.removalLog.findFirst({ where: { filePath: REL } });
            expect(log).not.toBeNull();
            expect(log!.reason).toBe("file-missing-grace");
            expect(log!.artistName).toBe("Recon Scan Artist");

            // Steps 5-6 ran AFTER the sweep and cascaded the newly-empty parents.
            expect(await prisma.album.findUnique({ where: { rgMbid: RG_MBID } })).toBeNull();
            expect(await prisma.artist.findFirst({ where: { name: "Recon Scan Artist" } })).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });

    it("flag mode (default config) deletes nothing across the same three scans", async () => {
        const scanner = new MusicScannerService();
        await scanner.scanLibrary(musicDir);
        fs.unlinkSync(trackFile);
        await scanner.scanLibrary(musicDir);
        await backdate();
        const third = await scanner.scanLibrary(musicDir);

        expect(third.tracksRemoved).toBe(0);
        expect(await prisma.track.findUnique({ where: { filePath: REL } })).not.toBeNull();
        expect(await prisma.removalLog.count({ where: { filePath: REL } })).toBe(0);
    });
});
