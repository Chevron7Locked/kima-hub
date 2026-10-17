/**
 * Every track gets a fingerprint stage, ISRC or not: the migration seeds it for
 * existing tracks and the claim creates it for new ones. It runs fpcalc locally,
 * so a paused 'acoustid' source does not block it, and progress counts it like
 * any stage. fpcalc is mocked; the database writes are real.
 */

// ── Queues + Redis + network services: observe, never hit the wire ──────

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });

jest.mock("../../workers/enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: { add: mockQueueAdd },
    trackQueue: { add: mockQueueAdd },
    vibeQueue: { add: mockQueueAdd },
    podcastQueue: { add: mockQueueAdd },
    createWorkerConnection: () => ({ host: "localhost", port: 6379 }),
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
}));

const mockRedis = {
    rpush: jest.fn().mockResolvedValue(1),
    llen: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    publish: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    scan: jest.fn().mockResolvedValue(["0", []]),
    status: "ready",
};

jest.mock("ioredis", () => jest.fn().mockImplementation(() => mockRedis));
jest.mock("../../config", () => ({
    config: { redisUrl: "redis://localhost:6379", music: { musicPath: "/music" } },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {
        updateState: jest.fn().mockResolvedValue({}),
        getState: jest.fn().mockResolvedValue(null),
        initializeState: jest.fn().mockResolvedValue({}),
        clear: jest.fn().mockResolvedValue(undefined),
        detectHang: jest.fn().mockResolvedValue(false),
        clearGate: jest.fn().mockResolvedValue(undefined),
        publishToChannel: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
        waitForStatus: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: jest.fn().mockResolvedValue({}),
        cleanupOrphanedFailures: jest.fn().mockResolvedValue({ cleaned: 0, checked: 0 }),
        cleanupOldResolved: jest.fn().mockResolvedValue(0),
        getFailures: jest.fn().mockResolvedValue({ failures: [], total: 0 }),
        getFailure: jest.fn().mockResolvedValue(null),
        getFailureCounts: jest.fn().mockResolvedValue({}),
        resetRetryCount: jest.fn().mockResolvedValue(0),
    },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({
            vibeEmbeddings: true, podcastSupport: false, fpcalc: true,
        }),
    },
}));

// The fpcalc binary is mocked: a fixed fingerprint for every file, the same
// ~3.4 kB shape a real Chromaprint run produces (the binary's own contract is
// fpcalcService's suite). Everything downstream of the subprocess — the
// stage claim, the persistence, the settle — is real.
const FINGERPRINT = "AQAA0pMiRZkQJBVZCSA98NOhHT-Q44eFB0sPPsgM_3hwnDgK7Yh6FCeOxyh-HMd5pDh6NEyQaDmuSjgSH8cXHdlyBSdiETAwHd-F88h3-Dt6KxlU5Dp27IPv4vk66Dz-JElw_Rm6HAWPJMmP_VCF8ki7CZ2h5sNfhD-0LT9-7I0jPMePsRT4HOeP50e0Fz_6Gs-P_7hChD-ePx06dDqaHT-Oy7hT_Dj2HHqND6WR5wieHN-w48iX4jvQ8Mh1PFKQJ9GeITl64QqP93hTfD0OHsd58IdU_Ax66DmOHxd0NEyQaDmuSjgSH8cXHdlyBSdiETAwHd-F88h3";
const mockFingerprintFile = jest.fn();
jest.mock("../../services/fpcalc", () => ({
    fpcalcService: {
        isAvailable: jest.fn().mockResolvedValue(true),
        fingerprintFile: (...args: unknown[]) => mockFingerprintFile(...args),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchRecording: jest.fn().mockResolvedValue(null),
        getRecordingGenres: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../workers/audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

jest.mock("../../workers/artistEnrichmentWorker", () => ({
    startArtistEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../../workers/trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../../workers/podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));

import fs from "fs";
import path from "path";

import { prisma } from "../../utils/db";
import { sourcePauseController } from "../../services/sourcePauseController";
import {
    STAGE_ORDER,
    executeFingerprintPhase,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
    waitForFingerprintWork,
} from "../../workers/unifiedEnrichment";

const PREFIX = "fp";
const id = (n: string) => `${PREFIX}_${n}`;

/** The migration that seeds a pending fingerprint record for every track. */
function fingerprintSeedMigrationSql(): string {
    const dir = path.join(
        __dirname, "..", "..", "..", "prisma", "migrations",
    );
    const seeded = fs
        .readdirSync(dir)
        .filter((m) => m.endsWith("_fingerprint_stage_seed"))
        .sort();
    if (seeded.length === 0) {
        throw new Error(
            "no *_fingerprint_stage_seed migration exists — every track must be seeded"
        );
    }
    return fs.readFileSync(
        path.join(dir, seeded[seeded.length - 1], "migration.sql"),
        "utf8",
    );
}

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Fingerprint Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Fingerprint Album", primaryType: "Album" },
    });
}

async function seedTrack(
    trackId: string,
    opts: { isrc?: string | null; recordingMbid?: string | null } = {},
): Promise<void> {
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
            isrc: opts.isrc ?? null,
            isrcSource: opts.isrc ? "id3" : null,
            recordingMbid: opts.recordingMbid ?? null,
        } as never,
    });
}

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { attempt?: number; retryable?: boolean } = {},
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, "lastErrorCode",
             "lastErrorMessage", "failureClass", retryable, "nextRetryAt", evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                source = EXCLUDED.source,
                attempt = EXCLUDED.attempt,
                "lastErrorCode" = EXCLUDED."lastErrorCode",
                "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                "failureClass" = EXCLUDED."failureClass",
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence`,
        `${trackId}__${stage}`, trackId, stage, status,
        "fpcalc", opts.attempt ?? 0,
        status === "done" ? null : "TEST_SEED",
        status === "done" ? null : "seeded by test",
        status === "done" ? null : "INCONCLUSIVE",
        opts.retryable ?? true, null,
        JSON.stringify({ probe: "seeded" }),
    );
}

async function stageRow(
    trackId: string,
    stage: string,
): Promise<{ status: string; attempt: number; source: string | null; finishedAt: Date | null } | null> {
    const rows = await prisma.$queryRawUnsafe<
        { status: string; attempt: number; source: string | null; finishedAt: Date | null }[]
    >(
        `SELECT status, attempt, source, "finishedAt" FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = $2`,
        trackId, stage,
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

async function seedEmbedding(trackId: string): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        `[${Array.from({ length: 512 }, (_, i) => (i % 7) / 7).join(",")}]`,
    );
}

async function wipe(): Promise<void> {
    // The seed covers every track, so start from an empty library.
    await prisma.$executeRawUnsafe(`DELETE FROM "Track"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "SourceAttempt"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "track_embeddings" WHERE track_id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

/** Dispatch the phase and drain the pool; returns how many were queued.
 * The dispatch returns immediately; the answers land on the pool's schedule. */
async function dispatchAndDrain(): Promise<number> {
    const queued = await executeFingerprintPhase();
    await waitForFingerprintWork();
    return queued;
}

beforeEach(async () => {
    jest.clearAllMocks();
    mockFingerprintFile.mockImplementation(async () => ({
        fingerprint: FINGERPRINT,
        duration: 218,
    }));
    await wipe();
    await seedLibrary();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("the fingerprint stage answers every track", () => {
    it("computes and stores a fingerprint for a track that HAS an ISRC", async () => {
        // Fully identified already, ISRC and recording MBID both present:
        // this class of track is fingerprinted too.
        const trackId = id("isrc");
        await seedTrack(trackId, { isrc: "FR10S1700001", recordingMbid: "mbid-known" });
        await putStage(trackId, "fingerprint", "pending");

        const queued = await dispatchAndDrain();

        expect(queued).toBe(1);
        // The fingerprint was computed locally and STORED on the track.
        expect(mockFingerprintFile).toHaveBeenCalledWith(
            expect.stringContaining("fp_isrc.flac"),
        );
        expect(await storedFingerprint(trackId)).toBe(FINGERPRINT);
        // And the stage record carries the answer.
        const row = await stageRow(trackId, "fingerprint");
        expect(row?.status).toBe("done");
        expect(row?.source).toBe("fpcalc");
        expect(row?.finishedAt).not.toBeNull();
    });

    it("does not recompute when the fingerprint is already stored", async () => {
        const trackId = id("stored");
        await seedTrack(trackId);
        await prisma.$executeRawUnsafe(
            `UPDATE "Track" SET "acoustidFingerprint" = $2 WHERE id = $1`,
            trackId, FINGERPRINT,
        );
        await putStage(trackId, "fingerprint", "pending");

        await dispatchAndDrain();

        // The answer already exists — answering the record from it costs no
        // fpcalc run and overwrites nothing with nothing.
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(await storedFingerprint(trackId)).toBe(FINGERPRINT);
        expect((await stageRow(trackId, "fingerprint"))?.status).toBe("done");
    });

    it("records a classified, retryable failure on the record when fpcalc fails", async () => {
        const trackId = id("broken");
        await seedTrack(trackId);
        await putStage(trackId, "fingerprint", "pending");
        mockFingerprintFile.mockImplementation(async () => null);

        await dispatchAndDrain();

        const row = await stageRow(trackId, "fingerprint");
        expect(row?.status).toBe("failed");
        expect(row?.attempt).toBe(1);
        // Retryable until the cap — a failed file is asked again on backoff,
        // never silently dropped and never parked as done.
        const failedRow = await prisma.$queryRawUnsafe<{ retryable: boolean }[]>(
            `SELECT retryable FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'fingerprint'`,
            trackId,
        );
        expect(failedRow[0]?.retryable).toBe(true);
        expect(await storedFingerprint(trackId)).toBeNull();
    });

    it("seeds a pending fingerprint record for EVERY existing track, and answers a new track's question the same way as the other stages", async () => {
        const a = id("exist_a");
        const b = id("exist_b");
        await seedTrack(a, { isrc: "FR10S1700002" });
        await seedTrack(b);

        // The migration runs its seed over every track that exists.
        await prisma.$executeRawUnsafe(fingerprintSeedMigrationSql());

        for (const trackId of [a, b]) {
            const row = await stageRow(trackId, "fingerprint");
            expect(row?.status).toBe("pending");
        }

        // A track created AFTER the migration (a new scan) gets its
        // fingerprint question answered through the same stage machinery as
        // the other stages: never-asked → claimed → answered.
        const fresh = id("new_track");
        await seedTrack(fresh);
        expect(await stageRow(fresh, "fingerprint")).toBeNull();

        // The phase answers the whole sweep: the two seeded rows plus the
        // never-asked new track.
        const queued = await dispatchAndDrain();
        expect(queued).toBe(3);
        for (const trackId of [a, b, fresh]) {
            expect((await stageRow(trackId, "fingerprint"))?.status).toBe("done");
        }
        expect(await storedFingerprint(fresh)).toBe(FINGERPRINT);
    });
});

describe("a paused 'acoustid' source blocks only the network lookup", () => {
    it("still computes and stores fingerprints while acoustid is paused", async () => {
        const trackId = id("paused");
        await seedTrack(trackId);
        await putStage(trackId, "fingerprint", "pending");

        // The network identity source refuses us.
        await sourcePauseController.pause("acoustid", {
            until: new Date(Date.now() + 60_000),
            code: "RATE_LIMITED",
            message: "seeded by test",
        });

        const queued = await dispatchAndDrain();

        // fpcalc is local — the pause must not stop the sweep.
        expect(queued).toBe(1);
        expect(await storedFingerprint(trackId)).toBe(FINGERPRINT);
        expect((await stageRow(trackId, "fingerprint"))?.status).toBe("done");

        // And the fingerprint stage is not keyed to any network source: it
        // stays available even with every network source paused.
        await sourcePauseController.pause("musicbrainz", {
            until: new Date(Date.now() + 60_000),
            code: "RATE_LIMITED",
        });
        const stillQueued = await dispatchAndDrain();
        expect(stillQueued).toBe(0); // this track is already answered...
        // ...but a NEW pending question is still offered and answered.
        const other = id("paused2");
        await seedTrack(other);
        await putStage(other, "fingerprint", "pending");
        expect(await dispatchAndDrain()).toBe(1);
        expect((await stageRow(other, "fingerprint"))?.status).toBe("done");
    });
});

describe("progress includes the fingerprint stage", () => {
    it("counts fingerprint records in the progress readout and keeps isFullyComplete honest", async () => {
        const done = id("prog_done");
        const pending = id("prog_pending");
        await seedTrack(done);
        await seedTrack(pending);
        for (const trackId of [done, pending]) {
            await putStage(trackId, "recording", "done");
            await putStage(trackId, "analysis", "done");
            await putStage(trackId, "embedding", "done");
            await seedEmbedding(trackId);
        }
        await putStage(done, "fingerprint", "done");
        await putStage(pending, "fingerprint", "pending");

        // The migration seed also covers every track that exists before a
        // test-created row does; run it so totals reflect the real sweep.
        await prisma.$executeRawUnsafe(fingerprintSeedMigrationSql());

        invalidateEnrichmentProgress();
        const progress = await getEnrichmentProgress();

        expect(progress.fingerprints).toBeDefined();
        expect(progress.fingerprints.total).toBeGreaterThanOrEqual(2);
        expect(progress.fingerprints.completed).toBeGreaterThanOrEqual(1);
        expect(progress.fingerprints.pending).toBeGreaterThanOrEqual(1);

        // A pending fingerprint question means enrichment is NOT fully
        // complete — every other stage here is answered.
        expect(progress.isFullyComplete).toBe(false);

        await dispatchAndDrain();
        invalidateEnrichmentProgress();
        const after = await getEnrichmentProgress();
        expect(after.fingerprints.pending).toBe(0);
    });
});

// STAGE_ORDER must carry the stage so the cycle, retry control, progress and
// re-decide sweep all walk it.
describe("the stage is part of the engine", () => {
    it("STAGE_ORDER includes 'fingerprint'", () => {
        expect(STAGE_ORDER).toContain("fingerprint");
    });
});
