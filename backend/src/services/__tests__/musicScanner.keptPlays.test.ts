/**
 * The whole path of a song's history through the library: a song is scanned in and played, its file goes and two scans
 * retire it (the plays stay as kept plays), the file comes back as a new song, and the recording is identified (the
 * identification stage names it) so the kept plays attach to the new song. The second case is the scan-end adoption: the
 * new song's recording is already known, so the scan that adds it attaches them.
 * Real scanner, real `identifyTrack`, temp directory, test database; only the outside services are mocked.
 */

jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../services/featureDetection", () => require("./helpers/scannerMocks").featureDetectionMock());
jest.mock("../../services/acoustidService", () => require("./helpers/scannerMocks").acoustidServiceMock());
jest.mock("../../services/fpcalc", () => require("./helpers/scannerMocks").fpcalcMock());
jest.mock("../../services/coverArtExtractor", () => require("./helpers/scannerMocks").coverArtExtractorMock());
jest.mock("../../services/artwork", () => require("./helpers/scannerMocks").artworkMock());
jest.mock("../../services/artistCountsService", () => require("./helpers/scannerMocks").artistCountsServiceMock());
jest.mock("../../services/imageStorage", () => require("./helpers/scannerMocks").imageStorageMock());

const mockReadTags = jest.fn();
jest.mock("../../services/acoustidIdentification", () => ({
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
    readIdentityTags: (...args: unknown[]) => mockReadTags(...args),
    identifyTrackByAcoustid: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        identifyRecording: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
        getRecordingGenres: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
        getRecordingIsrcAndGenres: jest.fn().mockResolvedValue({ isrc: { kind: "absent", evidence: {} }, genres: { kind: "absent", evidence: {} } }),
        lookupRecordingsByIsrc: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
        getAlbumCatalogue: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
    },
}));
jest.mock("../../services/trackIdentity", () => ({
    trackIdentityService: { populateTrackGenres: jest.fn().mockResolvedValue(undefined) },
}));

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { MusicScannerService } from "../musicScanner";
import { identifyTrack } from "../../workers/enrichment/identification";
import * as songHistory from "../library/songHistory";

jest.setTimeout(60_000);

const RG_MBID = "rg-keptplays-scan-1";
const REL = path.join("Kept Scan Artist", "Kept Scan Album", "01 - Returning.flac");
const REC = "33333333-3333-4333-8333-333333333333";
const USER = "zz-keptscan-user";
let musicDir: string;
let trackFile: string;

function writeFile(): void {
    fs.mkdirSync(path.dirname(trackFile), { recursive: true });
    fs.writeFileSync(trackFile, "dummy audio bytes");
}

async function wipe(): Promise<void> {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.$executeRawUnsafe(`DELETE FROM "RemovalLog" WHERE "filePath" = $1`, REL);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "filePath" = $1`, REL);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "rgMbid" = $1`, RG_MBID);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = $1`, "Kept Scan Artist");
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeEach(async () => {
    await wipe();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "kept-scan-"));
    trackFile = path.join(musicDir, REL);
    writeFile();
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockResolvedValue({
        common: { title: "Returning", artist: "Kept Scan Artist", albumartist: "Kept Scan Artist", album: "Kept Scan Album", track: { no: 1 }, disk: { no: 1 }, year: 2024, musicbrainz_releasegroupid: RG_MBID },
        format: { duration: 180, codec: "flac" },
        native: {},
    });
    mockReadTags.mockReset();
    mockReadTags.mockResolvedValue({ recordingMbid: REC, fingerprint: null, artists: [], duration: 180 });
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(musicDir, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

const songRow = () => prisma.track.findUnique({ where: { filePath: REL } });
const playsOnSong = (trackId: string) => prisma.play.count({ where: { userId: USER, trackId } });
const keptPlays = () => prisma.play.count({ where: { userId: USER, trackId: null, keptTitle: { not: null } } });

/** Scans the song in, plays it twice, takes the file away and lets two scans retire it. Answers the scanner. */
async function songPlayedAndRetired(scanner: MusicScannerService): Promise<void> {
    expect((await scanner.scanLibrary(musicDir)).tracksAdded).toBe(1);
    const first = (await songRow())!;
    await prisma.track.update({ where: { id: first.id }, data: { recordingMbid: REC } });
    await prisma.play.createMany({
        data: [
            { userId: USER, trackId: first.id, playedAt: new Date(Date.now() - 3 * 86_400_000) },
            { userId: USER, trackId: first.id, playedAt: new Date(Date.now() - 2 * 86_400_000) },
        ],
    });
    fs.unlinkSync(trackFile);
    expect((await scanner.scanLibrary(musicDir)).tracksMissing).toBe(1);
    expect((await scanner.scanLibrary(musicDir)).tracksRemoved).toBe(1);
    expect(await songRow()).toBeNull();
    expect(await keptPlays()).toBe(2);
}

describe("a recording that leaves the library and returns", () => {
    it("gets its plays back when the identification stage names it for the new song", async () => {
        const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
        try {
            const scanner = new MusicScannerService();
            await songPlayedAndRetired(scanner);

            // The file is back: the scan adds it as a new song, with no recording id yet, so nothing can be attached.
            writeFile();
            expect((await scanner.scanLibrary(musicDir)).tracksAdded).toBe(1);
            const returned = (await songRow())!;
            expect(returned.recordingMbid).toBeNull();
            expect(await keptPlays()).toBe(2);
            expect(await playsOnSong(returned.id)).toBe(0);

            // The identification stage names the recording, and the plays come with it.
            expect(await identifyTrack(returned.id)).toBe("identified");

            expect((await songRow())!.recordingMbid).toBe(REC);
            expect(await playsOnSong(returned.id)).toBe(2);
            expect(await keptPlays()).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });

    it("gets its plays back at the end of the scan that adds a song whose recording is already known", async () => {
        const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
        try {
            const scanner = new MusicScannerService();
            await songPlayedAndRetired(scanner);

            writeFile();
            expect((await scanner.scanLibrary(musicDir)).tracksAdded).toBe(1);
            const returned = (await songRow())!;
            // The recording becomes known some other way (an import, a tag the scanner does not read), then a scan ends.
            await prisma.track.update({ where: { id: returned.id }, data: { recordingMbid: REC } });
            await scanner.scanLibrary(musicDir);

            expect(await playsOnSong(returned.id)).toBe(2);
            expect(await keptPlays()).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });

    it("still prunes and finishes the scan when adopting kept plays fails", async () => {
        const config_ = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
        const adopt = jest.spyOn(songHistory, "adoptKeptPlays").mockRejectedValue(new Error("adoption timed out"));
        try {
            const scanner = new MusicScannerService();
            expect((await scanner.scanLibrary(musicDir)).tracksAdded).toBe(1);
            fs.unlinkSync(trackFile);
            expect((await scanner.scanLibrary(musicDir)).tracksMissing).toBe(1);

            // The retiring scan leaves an album with no songs, which the pruning after the adoption removes.
            const result = await scanner.scanLibrary(musicDir);

            expect(adopt).toHaveBeenCalled();
            expect(result.tracksRemoved).toBe(1);
            expect(await prisma.album.count({ where: { rgMbid: RG_MBID } })).toBe(0);
        } finally {
            adopt.mockRestore();
            config_.mockRestore();
        }
    });
});
