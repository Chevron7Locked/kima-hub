/**
 * A scan never deletes a track whose file vanished: the row, its plays, likes,
 * stage answers and embedding stay, the missing flag is set with a time, and a
 * later scan clears it. A file that cannot be read is an error, never an added
 * track. Real scanner, temp directory and test database.
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
import { config } from "../../config";
import { insertEmbeddings, vectorLiteral } from "../../__tests__/helpers/embeddingFixtures";

jest.setTimeout(60_000);

const ARTIST_NAME = "Scanmiss Artist";
const ALBUM_TITLE = "Scanmiss Album";
const RG_MBID = "rg-scanmiss-1";
const TRACK_TITLE = "Keep";
const USER = "scanmiss_user";
// The scanner keys every row on the file's path relative to the music root.
const REL = path.join("Artist", "Album", "01 - Keep.flac");

let musicDir: string;
let trackFile: string;

function writeFile(): void {
    fs.mkdirSync(path.dirname(trackFile), { recursive: true });
    fs.writeFileSync(trackFile, "dummy audio bytes");
}

function fakeMetadata() {
    return {
        common: {
            title: TRACK_TITLE,
            artist: ARTIST_NAME,
            albumartist: ARTIST_NAME,
            album: ALBUM_TITLE,
            track: { no: 1 },
            disk: { no: 1 },
            year: 2024,
            musicbrainz_releasegroupid: RG_MBID,
        },
        format: { duration: 180, codec: "flac" },
        native: {},
    };
}

async function findTrack() {
    return prisma.track.findUnique({ where: { filePath: REL } });
}

async function seedChildren(trackId: string): Promise<void> {
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
    await prisma.play.create({ data: { userId: USER, trackId } });
    await prisma.likedTrack.create({ data: { userId: USER, trackId } });
    await prisma.trackStage.create({
        data: {
            id: `${trackId}__recording`,
            trackId,
            stage: "recording",
            status: "done",
            source: "musicbrainz",
            attempt: 1,
            retryable: false,
            evidence: { question: "recording" },
        },
    });
    await insertEmbeddings([{ trackId, vector: vectorLiteral(Array(512).fill(0.1)) }]);
}

async function wipe(): Promise<void> {
    // Track deletion cascades to play/liked/stage/embedding. The rows are
    // wiped by the values the scan itself wrote, since the ids are cuids.
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "filePath" = $1`, REL);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "rgMbid" = $1`, RG_MBID);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = $1`, ARTIST_NAME);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, USER);
}

beforeEach(async () => {
    await wipe();
    // How a vanished file is flagged and its questions closed, scan after scan: flag mode, so nothing is retired.
    // Retiring is musicScanner.reconcile.test.ts.
    jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "flag" });

    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanmiss-"));
    trackFile = path.join(musicDir, REL);
    writeFile();

    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockResolvedValue(fakeMetadata());
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(musicDir, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("scan with a vanished file", () => {
    it("keeps the Track row, flags it missing with the found-missing time, and preserves its plays, likes, stage answer and embedding", async () => {
        const scanner = new MusicScannerService();

        // Scan 1: the file exists, the track is added clean.
        const first = await scanner.scanLibrary(musicDir);
        expect(first.tracksAdded).toBe(1);
        const added = await findTrack();
        expect(added).not.toBeNull();
        expect(added?.missingSince).toBeNull();
        const trackId = added!.id;

        // Real history accumulates against the row.
        await seedChildren(trackId);

        // The NAS hiccup: the file vanishes between scans.
        fs.unlinkSync(trackFile);

        const beforeMissing = new Date();
        const second = await scanner.scanLibrary(musicDir);
        const afterMissing = new Date();

        // The row is never deleted.
        const kept = await findTrack();
        expect(kept).not.toBeNull();
        expect(kept?.title).toBe(TRACK_TITLE);

        // The flag is the truth: missing, since the scan that found it gone.
        expect(kept?.missingSince).not.toBeNull();
        const missingSince = kept?.missingSince as Date;
        expect(missingSince.getTime()).toBeGreaterThanOrEqual(
            beforeMissing.getTime() - 1000
        );
        expect(missingSince.getTime()).toBeLessThanOrEqual(
            afterMissing.getTime() + 1000
        );

        // Nothing recorded against the track was cascaded away.
        expect(await prisma.play.count({ where: { trackId } })).toBe(1);
        expect(await prisma.likedTrack.count({ where: { trackId } })).toBe(1);
        expect(
            await prisma.trackStage.findUnique({
                where: { id: `${trackId}__recording` },
            })
        ).not.toBeNull();
        expect(
            await prisma.$queryRawUnsafe<Array<{ n: number }>>(
                `SELECT count(*)::int AS n FROM track_embeddings WHERE track_id = $1`,
                trackId
            )
        ).toEqual([{ n: 1 }]);

        // The scan reports the truth instead of a deletion.
        expect(second.tracksMissing).toBe(1);
    });

    it("clears the missing flag when a later scan finds the file again", async () => {
        const scanner = new MusicScannerService();

        const first = await scanner.scanLibrary(musicDir);
        expect(first.tracksAdded).toBe(1);
        const trackId = (await findTrack())!.id;
        await seedChildren(trackId);

        // Gone...
        fs.unlinkSync(trackFile);
        await scanner.scanLibrary(musicDir);
        expect((await findTrack())?.missingSince).not.toBeNull();

        // ...and back. The same relative path, a fresh file.
        writeFile();

        const third = await scanner.scanLibrary(musicDir);

        const row = await findTrack();
        expect(row).not.toBeNull();
        expect(row?.missingSince).toBeNull();
        // And the scan says so.
        expect(third.tracksMissing).toBe(0);
    });
});

/**
 * A missing file takes its open questions with it, and a returned file takes
 * them back, so no consumer of the progress count has to remember an exception
 * for records that stay `pending`.
 */
describe("stage records follow the file", () => {
    async function putStage(
        trackId: string,
        stage: string,
        status: string,
        opts: {
            retryable?: boolean;
            failureClass?: string;
            attempt?: number;
            decided?: boolean;
        } = {},
    ): Promise<void> {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, attempt, retryable,
                 "failureClass", "decidedAt", "decidedBy", evidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = EXCLUDED.status,
                    attempt = EXCLUDED.attempt,
                    retryable = EXCLUDED.retryable,
                    "failureClass" = EXCLUDED."failureClass",
                    "decidedAt" = EXCLUDED."decidedAt",
                    "decidedBy" = EXCLUDED."decidedBy"`,
            `${trackId}__${stage}`, trackId, stage, status,
            opts.attempt ?? 0, opts.retryable ?? true,
            opts.failureClass ?? null,
            opts.decided ? new Date() : null,
            opts.decided ? "test_human" : null,
            JSON.stringify({}),
        );
    }

    function stageRow(trackId: string, stage: string) {
        return prisma.trackStage.findUnique({
            where: { trackId_stage: { trackId, stage } },
        });
    }

    it("a vanished file closes its open questions as FILE_MISSING and leaves settled and in-flight records alone", async () => {
        const scanner = new MusicScannerService();
        await scanner.scanLibrary(musicDir);
        const trackId = (await findTrack())!.id;

        await putStage(trackId, "recording", "pending");
        await putStage(trackId, "analysis", "failed", { retryable: true });
        await putStage(trackId, "embedding", "done");
        await putStage(trackId, "fingerprint", "working");

        fs.unlinkSync(trackFile);
        await scanner.scanLibrary(musicDir);

        const rec = await stageRow(trackId, "recording");
        expect(rec?.status).toBe("failed");
        expect(rec?.retryable).toBe(false);
        expect(rec?.failureClass).toBe("FILE_MISSING");
        expect(rec?.lastErrorCode).toBe("FILE_MISSING");
        expect(rec?.finishedAt).not.toBeNull();

        // A retryable failure is an open question too.
        const ana = await stageRow(trackId, "analysis");
        expect(ana?.status).toBe("failed");
        expect(ana?.retryable).toBe(false);
        expect(ana?.failureClass).toBe("FILE_MISSING");

        // Settled and in-flight records are not this rule's to touch.
        expect((await stageRow(trackId, "embedding"))?.status).toBe("done");
        expect((await stageRow(trackId, "fingerprint"))?.status).toBe(
            "working"
        );
    });

    it("the scan that finds the file back re-opens only what the closure closed", async () => {
        const scanner = new MusicScannerService();
        await scanner.scanLibrary(musicDir);
        const trackId = (await findTrack())!.id;

        await putStage(trackId, "recording", "pending", { attempt: 2 });
        await putStage(trackId, "embedding", "pending");
        await putStage(trackId, "fingerprint", "failed", {
            retryable: false, failureClass: "RETRY_EXHAUSTED",
        });

        const originalMtime = fs.statSync(trackFile).mtime;
        fs.unlinkSync(trackFile);
        await scanner.scanLibrary(musicDir);
        expect(
            (await stageRow(trackId, "recording"))?.failureClass
        ).toBe("FILE_MISSING");

        // A person decided one closed record; the file returning must not overwrite that decision.
        await prisma.trackStage.update({
            where: { id: `${trackId}__embedding` },
            data: { decidedAt: new Date(), decidedBy: "test_human" },
        });

        // Back on the same path with an OLDER mtime than the row records —
        // the mount came back as it was, so the walk's "file unchanged"
        // skip must hold and only the flag/reopen path may fire.
        writeFile();
        const older = new Date(originalMtime.getTime() - 1000);
        fs.utimesSync(trackFile, older, older);
        await scanner.scanLibrary(musicDir);

        const rec = await stageRow(trackId, "recording");
        expect(rec?.status).toBe("pending");
        expect(rec?.failures).toBe(0);
        expect(rec?.failureClass).toBeNull();
        expect(rec?.finishedAt).toBeNull();

        const emb = await stageRow(trackId, "embedding");
        expect(emb?.status).toBe("failed");
        expect(emb?.decidedBy).toBe("test_human");

        const fp = await stageRow(trackId, "fingerprint");
        expect(fp?.status).toBe("failed");
        expect(fp?.failureClass).toBe("RETRY_EXHAUSTED");
    });

    it("a flagged track whose question is still pending gets closed by the next scan", async () => {
        // No flag flip is involved: the close runs over every flagged track each scan.
        const scanner = new MusicScannerService();
        await scanner.scanLibrary(musicDir);
        const trackId = (await findTrack())!.id;
        await putStage(trackId, "recording", "pending");

        fs.unlinkSync(trackFile);
        await scanner.scanLibrary(musicDir);
        // Put the record back to `pending`, so the next scan has a flagged track with an open question.
        await prisma.trackStage.update({
            where: { id: `${trackId}__recording` },
            data: {
                status: "pending", retryable: true, failureClass: null,
                lastErrorCode: null, finishedAt: null,
            },
        });

        await scanner.scanLibrary(musicDir);

        const rec = await stageRow(trackId, "recording");
        expect(rec?.status).toBe("failed");
        expect(rec?.retryable).toBe(false);
        expect(rec?.failureClass).toBe("FILE_MISSING");
    });
});

describe("scan with an unreadable file", () => {
    it("reports the file as an error, not an added track, on every scan", async () => {
        (parseFile as jest.Mock).mockRejectedValue(new Error("FourCC contains invalid characters"));
        const scanner = new MusicScannerService();

        for (let run = 0; run < 2; run++) {
            const result = await scanner.scanLibrary(musicDir);
            expect(result.tracksAdded).toBe(0);
            expect(result.tracksUpdated).toBe(0);
            expect(result.errors).toHaveLength(1);
        }
        expect(await findTrack()).toBeNull();
    });
});
