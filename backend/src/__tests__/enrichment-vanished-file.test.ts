/**
 * A song whose file an analyzer cannot find is flagged missing at once, its stage records close so nothing waits on
 * it, and a library scan is asked for; the scan's removal (libraryReconcile) then takes the song, logged to
 * RemovalLog, and the album and artist it empties. A file that is there after all, a stale report for a re-issued
 * claim, or an empty music folder (a drive that is not mounted) flags nothing. Real test database; the music folder
 * is a temporary one.
 */
const mockRequestScan = jest.fn().mockResolvedValue({ queued: true, jobId: "scan-full" });
jest.mock("../workers/scanRequest", () => ({ requestScan: (req: unknown) => mockRequestScan(req) }));

jest.mock("fs/promises", () => {
    const real = jest.requireActual("fs/promises");
    return { ...real, access: jest.fn(real.access) };
});

import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { prisma } from "../utils/db";
import { config, useMusicFolder } from "../config";
import * as stageRecords from "../services/stages/stageRecords";
import { runReconcile } from "../services/libraryReconcile";
import { pruneEmptyAlbumsAndArtists } from "../services/libraryPrune";
import { closeEngineConnections } from "./helpers/engineConnections";
import { redisClient } from "../utils/redis";
import { SCAN_AGAIN_KEY } from "../services/stages/stageRecords";

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

/** Waits until some statement in this database is blocked on a lock, so a test acts only once the move under test waits. */
async function waitUntilBlocked(): Promise<void> {
    for (let i = 0; i < 200; i++) {
        const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE NOT l.granted AND a.datname = current_database()`,
        );
        if (row.n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("nothing ever blocked on a lock");
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
    await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/gone.flac`), undefined, job(gone));

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
    await stageRecords.fail(gone, "analysis", "analyzer", new Error("File not found"), undefined, `track-${gone}-analysis-1-r0`);
    expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).not.toBeNull();
    const analysis = await prisma.trackStage.findUnique({ where: { trackId_stage: { trackId: gone, stage: "analysis" } } });
    expect(analysis).toMatchObject({ status: "failed", retryable: false, failureClass: "FILE_MISSING" });
});

it("notes a follow-up scan when one is already running, since that scan started before the flag", async () => {
    mockRequestScan.mockResolvedValueOnce({ queued: false, jobId: "scan-full", reason: "identical scan already active" });
    const gone = await song("midscan", `${P}/midscan.flac`);
    await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/midscan.flac`), undefined, job(gone));
    expect(await redisClient.get(SCAN_AGAIN_KEY)).toBe("1");
});

it("records an ordinary failure when the file cannot be read for another reason (permissions)", async () => {
    fs.mkdirSync(path.join(music, P, "locked"));
    fs.writeFileSync(path.join(music, P, "locked", "song.flac"), "x");
    const locked = await song("locked", `${P}/locked/song.flac`);
    fs.chmodSync(path.join(music, P, "locked"), 0o000);
    try {
        await stageRecords.fail(locked, "embedding", "clap", notFound(`${P}/locked/song.flac`), undefined, job(locked));
    } finally {
        fs.chmodSync(path.join(music, P, "locked"), 0o755);
    }
    expect((await prisma.track.findUnique({ where: { id: locked } }))?.missingSince).toBeNull();
    expect(mockRequestScan).not.toHaveBeenCalled();
});

it("records an ordinary failure when the file is there after all", async () => {
    const here = await song("here", `${P}/here.flac`);
    await stageRecords.fail(here, "embedding", "clap", notFound(`${P}/here.flac`), undefined, job(here));
    expect((await prisma.track.findUnique({ where: { id: here } }))?.missingSince).toBeNull();
    expect((await stageOf(here))?.status).toBe("failed");
    expect((await stageOf(here))?.failureClass).not.toBe("FILE_MISSING");
    expect(mockRequestScan).not.toHaveBeenCalled();
});

it("ignores a stale report for a claim that was handed out again", async () => {
    const gone = await song("stale", `${P}/stale.flac`);
    await prisma.trackStage.update({ where: { trackId_stage: { trackId: gone, stage: "embedding" } }, data: { attempt: 2 } });
    await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/stale.flac`), undefined, job(gone, 1));
    expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).toBeNull();
    expect(mockRequestScan).not.toHaveBeenCalled();
});

describe("a report whose claim changes while the file is being checked", () => {
    /** Runs `change` once the report has looked at the folder, before it flags anything. */
    function changeDuringCheck(change: () => Promise<unknown>): void {
        const realAccess = jest.requireActual<typeof fsPromises>("fs/promises").access;
        (fsPromises.access as jest.Mock).mockImplementationOnce(async (...args: Parameters<typeof realAccess>) => {
            await change();
            return realAccess(...args);
        });
    }

    it("flags nothing when the claim was handed out again meanwhile", async () => {
        const gone = await song("race1", `${P}/race1.flac`);
        changeDuringCheck(() =>
            prisma.trackStage.update({ where: { trackId_stage: { trackId: gone, stage: "embedding" } }, data: { attempt: 2 } }),
        );
        await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/race1.flac`), undefined, job(gone, 1));

        expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).toBeNull();
        expect(await stageOf(gone)).toMatchObject({ status: "working", attempt: 2 });
        expect(mockRequestScan).not.toHaveBeenCalled();
    });

    it("flags nothing when the question was answered meanwhile", async () => {
        const gone = await song("race2", `${P}/race2.flac`);
        changeDuringCheck(() =>
            prisma.trackStage.update({ where: { trackId_stage: { trackId: gone, stage: "embedding" } }, data: { status: "done" } }),
        );
        await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/race2.flac`), undefined, job(gone, 1));

        expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).toBeNull();
        expect((await stageOf(gone))?.status).toBe("done");
        expect(mockRequestScan).not.toHaveBeenCalled();
    });
});

it("flags nothing for a file-missing report that names no claim, and records it as an ordinary failure", async () => {
    const gone = await song("noclaim", `${P}/noclaim.flac`);
    await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/noclaim.flac`));
    expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).toBeNull();
    expect((await stageOf(gone))?.failureClass).not.toBe("FILE_MISSING");
    expect(mockRequestScan).not.toHaveBeenCalled();
});

describe("flagging a song", () => {
    /** A second flagged song whose open record the sweep, not this flag, is there to close. */
    async function otherFlaggedSong(): Promise<string> {
        const other = await song("other", `${P}/other.flac`);
        await prisma.trackStage.update({
            where: { trackId_stage: { trackId: other, stage: "embedding" } },
            data: { status: "pending", nextRetryAt: null },
        });
        await prisma.track.update({ where: { id: other }, data: { missingSince: new Date() } });
        return other;
    }

    it("closes only the flagged song's records; another flagged song waits for the sweep", async () => {
        const other = await otherFlaggedSong();
        const gone = await song("scoped", `${P}/scoped.flac`);

        await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/scoped.flac`), undefined, job(gone));

        expect((await stageOf(gone))?.failureClass).toBe("FILE_MISSING");
        expect((await stageOf(other))?.status).toBe("pending");
        expect(await stageRecords.closeForMissingFiles()).toBe(1);
        expect((await stageOf(other))?.failureClass).toBe("FILE_MISSING");
    });

    it("takes the song's records before its Track row, as a claim does, so the two cannot deadlock", async () => {
        const gone = await song("order", `${P}/order.flac`);
        await prisma.trackStage.create({ data: { trackId: gone, stage: "analysis", status: "pending", retryable: true } });

        // Another transaction holds the song's analysis record; the flag must wait there, not holding the Track row.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let held!: () => void;
        const ready = new Promise<void>((resolve) => { held = resolve; });
        const holder = prisma.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(`SELECT 1 FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'analysis' FOR UPDATE`, gone);
            held();
            await gate;
        });
        await ready;
        const reporting = stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/order.flac`), undefined, job(gone));
        try {
            await waitUntilBlocked();
            // NOWAIT fails at once if the flag already holds the Track row.
            await expect(
                prisma.$queryRawUnsafe(`SELECT 1 FROM "Track" WHERE id = $1 FOR UPDATE NOWAIT`, gone),
            ).resolves.toBeDefined();
        } finally {
            release();
            await holder;
        }
        await reporting;
        expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).not.toBeNull();
        expect((await stageOf(gone))?.failureClass).toBe("FILE_MISSING");
    });

    describe("when Postgres picks the flag as a deadlock victim", () => {
        const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "P2010", meta: { code: "40P01" } });
        afterEach(() => jest.restoreAllMocks());

        it("tries the flag once more", async () => {
            const gone = await song("dead1", `${P}/dead1.flac`);
            jest.spyOn(prisma, "$transaction").mockRejectedValueOnce(deadlock() as never);

            await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/dead1.flac`), undefined, job(gone));

            expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).not.toBeNull();
            expect((await stageOf(gone))?.failureClass).toBe("FILE_MISSING");
        });

        it("gives up after that one retry, and a failure that is not a deadlock is not retried", async () => {
            const gone = await song("dead2", `${P}/dead2.flac`);
            const spy = jest.spyOn(prisma, "$transaction")
                .mockRejectedValueOnce(deadlock() as never)
                .mockRejectedValueOnce(deadlock() as never);
            await expect(
                stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/dead2.flac`), undefined, job(gone)),
            ).rejects.toThrow("deadlock detected");
            expect(spy).toHaveBeenCalledTimes(2);

            spy.mockReset();
            spy.mockRejectedValueOnce(new Error("connection reset") as never);
            await expect(
                stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/dead2.flac`), undefined, job(gone)),
            ).rejects.toThrow("connection reset");
            expect(spy).toHaveBeenCalledTimes(1);
        });
    });
});

it("flags nothing when the music folder is empty: the drive is not mounted", async () => {
    const gone = await song("unmounted", `${P}/unmounted.flac`);
    fs.rmSync(path.join(music, P), { recursive: true, force: true });
    await stageRecords.fail(gone, "embedding", "clap", notFound(`${P}/unmounted.flac`), undefined, job(gone));
    expect((await prisma.track.findUnique({ where: { id: gone } }))?.missingSince).toBeNull();
    expect(mockRequestScan).not.toHaveBeenCalled();
});
