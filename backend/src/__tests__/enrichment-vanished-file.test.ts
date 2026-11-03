/**
 * A song whose file an analyzer cannot find is flagged missing at once, its stage records close so nothing waits on
 * it, and a library scan is asked for; the scan's removal (libraryReconcile) then takes the song, logged to
 * RemovalLog, and the album and artist it empties. A file that is there after all, a stale report for a re-issued
 * claim, or an empty music folder (a drive that is not mounted) flags nothing. Real test database; the music folder
 * is a temporary one.
 */
const mockRequestScan = jest.fn().mockResolvedValue({ queued: true, jobId: "scan-full" });
jest.mock("../workers/scanRequest", () => ({ requestScan: (req: unknown) => mockRequestScan(req) }));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { prisma } from "../utils/db";
import { config, useMusicFolder } from "../config";
import { recordStageFailure } from "../workers/unifiedEnrichment";
import { runReconcile } from "../services/libraryReconcile";
import { pruneEmptyAlbumsAndArtists } from "../services/libraryPrune";
import { closeEngineConnections } from "./helpers/engineConnections";
import { redisClient } from "../utils/redis";
import { SCAN_AGAIN_KEY } from "../services/missingFileStages";

const P = "vanish";
const id = (n: string) => `${P}_${n}`;
const originalFolder = config.music.musicPath;
let music = "";

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "RemovalLog" WHERE "filePath" LIKE $1`, `${P}/%`);
}

/** One artist with one album holding one song at `filePath`, its sound vector in flight under claim 1. */
async function song(name: string, filePath: string): Promise<string> {
    await prisma.artist.create({ data: { id: id(`art_${name}`), name: `Vanish ${name}`, identityKey: id(`ak_${name}`) } });
    await prisma.album.create({
        data: { id: id(`alb_${name}`), rgMbid: id(`rg_${name}`), artistId: id(`art_${name}`), title: `Vanish ${name}`, primaryType: "Album" },
    });
    await prisma.track.create({
        data: { id: id(name), albumId: id(`alb_${name}`), title: name, trackNo: 1, duration: 180, filePath, fileModified: new Date(), fileSize: 1 },
    });
    await prisma.trackStage.create({
        data: { trackId: id(name), stage: "embedding", status: "working", attempt: 1, redelivered: 0, retryable: true, nextRetryAt: new Date(Date.now() + 60_000) },
    });
    return id(name);
}

const job = (trackId: string, attempt = 1) => `track-${trackId}-embedding-${attempt}-r0`;
const notFound = (filePath: string) => new Error(`File not found: ${filePath}`);
const stageOf = (trackId: string) => prisma.trackStage.findUnique({ where: { trackId_stage: { trackId, stage: "embedding" } } });

beforeEach(async () => {
    await wipe();
    mockRequestScan.mockClear();
    music = fs.mkdtempSync(path.join(os.tmpdir(), "kima-vanish-"));
    fs.mkdirSync(path.join(music, P));
    fs.writeFileSync(path.join(music, P, "here.flac"), "x");
    useMusicFolder(music);
});

// In an afterEach: the shared Redis clients are closed before the file's afterAll hooks run.
afterEach(async () => {
    await redisClient.del(SCAN_AGAIN_KEY);
    useMusicFolder(originalFolder);
    fs.rmSync(music, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await closeEngineConnections();
});

it("flags a song whose file is gone, closes its records and asks for a scan, which then removes it", async () => {
    const gone = await song("gone", `${P}/gone.flac`);
    await recordStageFailure(gone, "embedding", "clap", notFound(`${P}/gone.flac`), undefined, job(gone));

    const track = await prisma.track.findUnique({ where: { id: gone } });
    expect(track?.missingSince).not.toBeNull();
    const stage = await stageOf(gone);
    expect(stage).toMatchObject({ status: "failed", retryable: false, failureClass: "FILE_MISSING" });
    expect(mockRequestScan).toHaveBeenCalledWith(expect.objectContaining({ source: "vanished-file" }));

    // The scan that follows confirms it is still gone: the reconcile takes it, and prunes what it emptied.
    await runReconcile(new Date());
    await pruneEmptyAlbumsAndArtists();
    expect(await prisma.track.findUnique({ where: { id: gone } })).toBeNull();
    expect(await prisma.album.findUnique({ where: { id: id("alb_gone") } })).toBeNull();
    expect(await prisma.artist.findUnique({ where: { id: id("art_gone") } })).toBeNull();
    expect(await prisma.removalLog.count({ where: { filePath: `${P}/gone.flac` } })).toBe(1);
});

it("treats MusiCNN's report the same way", async () => {
    const gone = await song("gone2", `${P}/gone2.flac`);
    await prisma.trackStage.create({ data: { trackId: gone, stage: "analysis", status: "working", attempt: 1, retryable: true } });
    await recordStageFailure(gone, "analysis", "analyzer", new Error("File not found"));
    expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).not.toBeNull();
    const analysis = await prisma.trackStage.findUnique({ where: { trackId_stage: { trackId: gone, stage: "analysis" } } });
    expect(analysis).toMatchObject({ status: "failed", retryable: false, failureClass: "FILE_MISSING" });
});

it("notes a follow-up scan when one is already running, since that scan started before the flag", async () => {
    mockRequestScan.mockResolvedValueOnce({ queued: false, jobId: "scan-full", reason: "identical scan already active" });
    const gone = await song("midscan", `${P}/midscan.flac`);
    await recordStageFailure(gone, "embedding", "clap", notFound(`${P}/midscan.flac`), undefined, job(gone));
    expect(await redisClient.get(SCAN_AGAIN_KEY)).toBe("1");
});

it("records an ordinary failure when the file cannot be read for another reason (permissions)", async () => {
    fs.mkdirSync(path.join(music, P, "locked"));
    fs.writeFileSync(path.join(music, P, "locked", "song.flac"), "x");
    const locked = await song("locked", `${P}/locked/song.flac`);
    fs.chmodSync(path.join(music, P, "locked"), 0o000);
    try {
        await recordStageFailure(locked, "embedding", "clap", notFound(`${P}/locked/song.flac`), undefined, job(locked));
    } finally {
        fs.chmodSync(path.join(music, P, "locked"), 0o755);
    }
    expect((await prisma.track.findUnique({ where: { id: locked } }))?.missingSince).toBeNull();
    expect(mockRequestScan).not.toHaveBeenCalled();
});

it("records an ordinary failure when the file is there after all", async () => {
    const here = await song("here", `${P}/here.flac`);
    await recordStageFailure(here, "embedding", "clap", notFound(`${P}/here.flac`), undefined, job(here));
    expect((await prisma.track.findUnique({ where: { id: here } }))?.missingSince).toBeNull();
    expect((await stageOf(here))?.status).toBe("failed");
    expect((await stageOf(here))?.failureClass).not.toBe("FILE_MISSING");
    expect(mockRequestScan).not.toHaveBeenCalled();
});

it("ignores a stale report for a claim that was handed out again", async () => {
    const gone = await song("stale", `${P}/stale.flac`);
    await prisma.trackStage.update({ where: { trackId_stage: { trackId: gone, stage: "embedding" } }, data: { attempt: 2 } });
    await recordStageFailure(gone, "embedding", "clap", notFound(`${P}/stale.flac`), undefined, job(gone, 1));
    expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).toBeNull();
    expect(mockRequestScan).not.toHaveBeenCalled();
});

it("flags nothing when the music folder is empty: the drive is not mounted", async () => {
    const gone = await song("unmounted", `${P}/unmounted.flac`);
    fs.rmSync(path.join(music, P), { recursive: true, force: true });
    await recordStageFailure(gone, "embedding", "clap", notFound(`${P}/unmounted.flac`), undefined, job(gone));
    expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).toBeNull();
    expect(mockRequestScan).not.toHaveBeenCalled();
});
