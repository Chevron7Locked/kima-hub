/**
 * The fingerprint job, through its own interface and no scheduler: a claimed question is answered with
 * fpcalc (or from the stored fingerprint), a pool runs a bounded number at once and returns at once, and a hung
 * fpcalc becomes a recorded, retryable failure at the budget while the other slots keep working.
 */

jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockFingerprintFile = jest.fn();
const mockFeatures = jest.fn();
jest.mock("../../../services/featureDetection", () => ({
    featureDetection: { getFeatures: () => mockFeatures() },
}));

jest.mock("../../../services/fpcalc", () => ({
    ...jest.requireActual("../../../services/fpcalc"),
    fpcalcService: {
        isAvailable: jest.fn().mockResolvedValue(true),
        fingerprintFile: (...args: unknown[]) => mockFingerprintFile(...args),
    },
}));

// Let the seeded relative paths resolve; a path that climbs out of the music folder does not.
jest.mock("../../../routes/library/trackPath", () => ({
    resolveWithinMusicRoot: (p: string) => (p.includes("..") ? null : p),
}));

import { prisma } from "../../../utils/db";
import * as stageRecords from "../../../services/stages/stageRecords";
import { putStage } from "../../../__tests__/helpers/trackStage";
import {
    ACOUSTID_NOT_ASKED,
    answerFingerprint,
    createFingerprintPool,
    FINGERPRINT_BUDGET_MS,
    runFingerprints,
    waitForFingerprintWork,
    type FingerprintItem,
} from "../fingerprint";
import { FPCALC_TIMEOUT_MS } from "../../../services/fpcalc";
import type { StageOffer } from "../stageOffer";

const PREFIX = "fpmod";
const id = (n: string) => `${PREFIX}_${n}`;
const FINGERPRINT = "AQAA0pMiRZkQJBVZCSA98NOhHT-Q44eFB0sPPsgM_3hwnDgK7Yh6FCeOxyh-HMd5pDh6NEyQaDmuSjgSH8cXHdlyBSdiETAwHd-F88h3";

async function seedTrack(trackId: string, extra: Record<string, unknown> = {}): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 218,
            filePath: `artist/album/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            ...extra,
        } as never,
    });
}

/** Seeds the song and claims its fingerprint question, as the scheduler does before offering it. */
async function claimed(trackId: string, extra: Record<string, unknown> = {}): Promise<FingerprintItem> {
    await seedTrack(trackId, extra);
    const result = await stageRecords.claim(trackId, "fingerprint", { jobKey: `track-${trackId}-fingerprint` });
    if (result.kind !== "claimed") throw new Error(`expected a claim, got ${result.kind}`);
    const track = await prisma.track.findUniqueOrThrow({ where: { id: trackId }, select: { filePath: true } });
    return { trackId, filePath: track.filePath, jobId: result.jobId };
}

async function stageRow(trackId: string, stage = "fingerprint") {
    const rows = await prisma.$queryRawUnsafe<
        { status: string; attempt: number; lastErrorCode: string | null; retryable: boolean; evidence: Record<string, unknown> }[]
    >(
        `SELECT status, attempt, "lastErrorCode", retryable, evidence FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = $2`,
        trackId,
        stage,
    );
    return rows[0] ?? null;
}

async function storedFingerprint(trackId: string): Promise<string | null> {
    const rows = await prisma.$queryRawUnsafe<{ fingerprint: string | null }[]>(
        `SELECT "acoustidFingerprint" AS fingerprint FROM "Track" WHERE id = $1`,
        trackId,
    );
    return rows[0]?.fingerprint ?? null;
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

async function waitUntil(done: () => boolean, what: string): Promise<void> {
    const started = Date.now();
    while (!done()) {
        if (Date.now() - started > 5000) throw new Error(`never reached: ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

beforeEach(async () => {
    jest.clearAllMocks();
    mockFingerprintFile.mockReset();
    await wipe();
    await prisma.artist.create({ data: { id: id("art"), name: "FpMod Artist", identityKey: id("a") } });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "FpMod Album", primaryType: "Album" },
    });
});

afterAll(async () => {
    await wipe();
});

describe("answerFingerprint", () => {
    it("fingerprints the file, stores the fingerprint and answers the question", async () => {
        mockFingerprintFile.mockResolvedValue({ fingerprint: FINGERPRINT, duration: 218 });
        const item = await claimed(id("a1"));

        await answerFingerprint(item);

        expect(mockFingerprintFile).toHaveBeenCalledWith(expect.stringContaining("fpmod_a1.flac"));
        expect((await stageRow(id("a1")))?.status).toBe("done");
        expect(await storedFingerprint(id("a1"))).toBe(FINGERPRINT);
    });

    it("reuses a stored fingerprint and never runs fpcalc", async () => {
        const item = await claimed(id("a2"), { acoustidFingerprint: FINGERPRINT });

        await answerFingerprint(item);

        expect(mockFingerprintFile).not.toHaveBeenCalled();
        const row = await stageRow(id("a2"));
        expect(row?.status).toBe("done");
        expect(row?.evidence).toMatchObject({ reason: "fingerprint already stored" });
    });

    it("fails the question, retryable, when fpcalc fails", async () => {
        mockFingerprintFile.mockRejectedValue(new Error("fpcalc exited 3"));
        const item = await claimed(id("a3"));

        await answerFingerprint(item);

        const row = await stageRow(id("a3"));
        expect(row?.status).toBe("failed");
        expect(row?.retryable).toBe(true);
        expect(await storedFingerprint(id("a3"))).toBeNull();
    });

    it("fails the question, without running fpcalc, when the file path leaves the music folder", async () => {
        const item = await claimed(id("a4"), { filePath: "../outside/a4.flac" });

        await answerFingerprint(item);

        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect((await stageRow(id("a4")))?.status).toBe("failed");
    });

    it("drops a song deleted since it was claimed, quietly: nothing is thrown and no failure is recorded", async () => {
        const gone: FingerprintItem = { trackId: id("gone"), filePath: "artist/album/gone.flac", jobId: "job-gone" };

        await expect(answerFingerprint(gone)).resolves.toBeUndefined();

        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(await stageRow(id("gone"))).toBeNull();
    });

    it("reopens a recording no-match that never asked AcoustID, once the fingerprint lands", async () => {
        mockFingerprintFile.mockResolvedValue({ fingerprint: FINGERPRINT, duration: 218 });
        const item = await claimed(id("a5"));
        await putStage(id("a5"), "recording", "done", { evidence: { acoustid: ACOUSTID_NOT_ASKED } });

        await answerFingerprint(item);

        expect((await stageRow(id("a5"), "recording"))?.status).toBe("pending");
    });

    it("leaves a recording answer alone when AcoustID was asked", async () => {
        mockFingerprintFile.mockResolvedValue({ fingerprint: FINGERPRINT, duration: 218 });
        const item = await claimed(id("a6"));
        await putStage(id("a6"), "recording", "done", { evidence: { acoustid: "no match" } });

        await answerFingerprint(item);

        expect((await stageRow(id("a6"), "recording"))?.status).toBe("done");
    });
});

describe("the fingerprint pool", () => {
    /** fingerprintFile hangs until released, counting live runs. */
    function gatedFpcalc() {
        let live = 0;
        const state = { maxLive: 0, live: 0, gates: [] as Array<() => void> };
        mockFingerprintFile.mockImplementation(async () => {
            live++;
            state.live = live;
            state.maxLive = Math.max(state.maxLive, live);
            await new Promise<void>((resolve) => state.gates.push(resolve));
            live--;
            state.live = live;
            return { fingerprint: FINGERPRINT, duration: 218 };
        });
        return state;
    }

    it("runs at most its concurrency at once, and start returns before the work does", async () => {
        const state = gatedFpcalc();
        const pool = createFingerprintPool({ concurrency: 2, budgetMs: 10_000 });
        const items: FingerprintItem[] = [];
        for (const n of ["c1", "c2", "c3", "c4"]) items.push(await claimed(id(n)));

        for (const item of items) pool.start(item);
        // start returned with nothing answered yet.
        expect((await stageRow(id("c1")))?.status).toBe("working");

        await waitUntil(() => state.live === 2, "two runs in flight");
        expect(state.maxLive).toBe(2);

        const drained = pool.settled();
        for (let round = 0; round < 200; round++) {
            while (state.gates.length) state.gates.shift()?.();
            const done = await Promise.race([
                drained.then(() => true),
                new Promise<boolean>((r) => setTimeout(() => r(false), 20)),
            ]);
            if (done) break;
        }
        await drained;

        expect(state.maxLive).toBe(2);
        for (const item of items) {
            expect((await stageRow(item.trackId))?.status).toBe("done");
            expect(await storedFingerprint(item.trackId)).toBe(FINGERPRINT);
        }
    });

    it("records a hung fpcalc as a retryable failure at the budget, and the other slots keep working", async () => {
        mockFingerprintFile.mockImplementation(async (p: string) => {
            if (p.includes("fpmod_h")) return new Promise<never>(() => undefined);
            return { fingerprint: FINGERPRINT, duration: 218 };
        });
        const pool = createFingerprintPool({ concurrency: 2, budgetMs: 250 });
        const hung1 = await claimed(id("h1"));
        const hung2 = await claimed(id("h2"));
        const quick = await claimed(id("q1"));

        for (const item of [hung1, hung2, quick]) pool.start(item);
        await pool.settled();

        for (const item of [hung1, hung2]) {
            const row = await stageRow(item.trackId);
            expect(row?.status).toBe("failed");
            expect(row?.attempt).toBe(1);
            expect(row?.retryable).toBe(true);
            expect(row?.evidence).toMatchObject({ timedOut: true });
            expect(await storedFingerprint(item.trackId)).toBeNull();
        }
        expect((await stageRow(quick.trackId))?.status).toBe("done");
        expect(await storedFingerprint(quick.trackId)).toBe(FINGERPRINT);
    });
});

describe("the fingerprint budget", () => {
    it("stays above fpcalc's own timeout, so a slot never frees while fpcalc still runs", () => {
        expect(FINGERPRINT_BUDGET_MS).toBeGreaterThan(FPCALC_TIMEOUT_MS);
    });
});

describe("runFingerprints", () => {
    /** An offer that hands out the given claimed items and starts each, as the scheduler's dispatch does. */
    function offerOf(items: FingerprintItem[]) {
        const nextWork = jest.fn(async (_limit: number) => items as never);
        const offer: StageOffer = {
            window: async () => 7,
            nextWork,
            dispatch: async (work, produce) => {
                for (const item of work) await produce(item);
                return work.length;
            },
        };
        return { offer, nextWork };
    }

    it("offers and queues nothing when this install has no fpcalc", async () => {
        mockFeatures.mockResolvedValue({ fpcalc: false });
        const { offer, nextWork } = offerOf([]);

        expect(await runFingerprints(offer)).toBe(0);
        expect(nextWork).not.toHaveBeenCalled();
    });

    it("asks for its own window of songs and starts each in the pool", async () => {
        mockFeatures.mockResolvedValue({ fpcalc: true });
        mockFingerprintFile.mockResolvedValue({ fingerprint: FINGERPRINT, duration: 218 });
        const item = await claimed(id("r1"));
        const { offer, nextWork } = offerOf([item]);

        expect(await runFingerprints(offer)).toBe(1);
        await waitForFingerprintWork();

        expect(nextWork).toHaveBeenCalledWith(7);
        expect((await stageRow(id("r1")))?.status).toBe("done");
    });
});
