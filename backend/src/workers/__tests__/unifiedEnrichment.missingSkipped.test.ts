/**
 * A track whose file the scan flagged missing is never offered to a stage and
 * its record is left as it was. When the file returns, the question is due again.
 */

// ── Queues + Redis + network services: observe, never hit the wire ──────────

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });
const mockQueueClean = jest.fn().mockResolvedValue([]);
const mockQueueGetJob = jest.fn().mockResolvedValue(null);
const mockQueueResume = jest.fn().mockResolvedValue(undefined);

jest.mock("../../workers/enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    trackQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    vibeQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    podcastQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
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

const mockRecordFailure = jest.fn().mockResolvedValue({});

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: mockRecordFailure,
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

jest.mock("../../services/trackIdentity", () => ({
    trackIdentityService: {
        populateTrackGenres: jest.fn().mockResolvedValue(undefined),
        storeIsrc: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchRecording: jest.fn().mockResolvedValue(null),
        getRecordingGenres: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../services/acoustidIdentification", () => ({
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
    identifyTrackByAcoustid: jest.fn().mockResolvedValue(null),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        isPaused: jest.fn().mockResolvedValue(false),
        open: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        handleRateLimit: jest.fn().mockResolvedValue(false),
        getPause: jest.fn().mockResolvedValue(null),
        windowMs: 60_000,
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

import { prisma } from "../../utils/db";
import {
    waitForFingerprintWork,
    getNextWork,
    retryFailedAndBlocked,
} from "../../workers/unifiedEnrichment";

const PREFIX = "scanmiss";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedAlbum(): Promise<string> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Scanmiss Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Scanmiss Album", primaryType: "Album" },
    });
    return id("alb");
}

async function seedTrack(
    trackId: string,
    opts: { missingSince?: Date | null } = {},
): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 180,
            filePath: `/music/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            missingSince: opts.missingSince ?? null,
        } as never,
    });
}

async function wipe(): Promise<void> {
    await waitForFingerprintWork();
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await seedAlbum();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("enrichment skips a track flagged missing", () => {
    it("getNextWork never offers it", async () => {
        await seedTrack(id("present"));
        await seedTrack(id("gone"), { missingSince: new Date() });
        // The fingerprint question is SETTLED for both tracks, so the
        // recording question is genuinely due for the present track — the
        // missing flag is the only difference under test.
        for (const trackId of [id("present"), id("gone")]) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO "TrackStage"
                    (id, "trackId", stage, status, source, attempt, retryable, evidence)
                 VALUES ($1, $2, 'fingerprint', 'done', 'fpcalc', 1, false, $3::jsonb)`,
                `${trackId}__fingerprint`,
                trackId,
                JSON.stringify({ question: "fingerprint" }),
            );
        }

        const work = await getNextWork(10, "recording");

        expect(work.map((w) => w.trackId)).toEqual([id("present")]);
    });

    it("the control neither offers it, nor queues it, nor fails it, and its attempt is untouched", async () => {
        await seedTrack(id("gone"), { missingSince: new Date() });
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable, evidence)
             VALUES ($1, $2, 'recording', 'pending', 'musicbrainz', 2, true, $3::jsonb)`,
            `${id("gone")}__recording`,
            id("gone"),
            JSON.stringify({ question: "recording" }),
        );

        const work = await retryFailedAndBlocked();

        expect(work.map((w) => w.trackId)).not.toContain(id("gone"));
        // Nothing was queued anywhere.
        expect(mockQueueAdd).not.toHaveBeenCalled();
        // No failure was recorded for it.
        expect(mockRecordFailure).not.toHaveBeenCalled();

        // The record is exactly as it was: an attempt was not consumed.
        const stage = await prisma.$queryRawUnsafe<Array<{ status: string; attempt: number }>>(
            `SELECT status, attempt FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'recording'`,
            id("gone"),
        );
        expect(stage).toEqual([{ status: "pending", attempt: 2 }]);
    });

    it("offers it again once the scan clears the flag", async () => {
        await seedTrack(id("back"), { missingSince: new Date() });
        // The fingerprint question is settled, so once the flag clears the
        // recording question is genuinely due — the flag is the only thing
        // holding it back.
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable, evidence)
             VALUES ($1, $2, 'fingerprint', 'done', 'fpcalc', 1, false, $3::jsonb)`,
            `${id("back")}__fingerprint`,
            id("back"),
            JSON.stringify({ question: "fingerprint" }),
        );
        expect(await getNextWork(10, "recording")).toEqual([]);

        await prisma.track.update({
            where: { id: id("back") },
            data: { missingSince: null },
        });

        const work = await getNextWork(10, "recording");
        expect(work.map((w) => w.trackId)).toEqual([id("back")]);
    });
});
