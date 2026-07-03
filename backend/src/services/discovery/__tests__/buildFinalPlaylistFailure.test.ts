/**
 * Task 5 -- buildFinalPlaylist must mark the batch `failed` when the
 * playlist-creation `$transaction` throws.
 *
 * Doctrine: failure path first. The single test that matters drives the
 * transaction CATCH at discoverWeekly.ts:1440 and asserts the discriminating
 * errorMessage "Playlist build failed: ..." -- a string ONLY the catch can
 * produce. The pre-existing no-tracks short-circuit (:1043) also marks the
 * batch failed but with errorMessage "No tracks found after scan", so the
 * fixture is built to sail past that short-circuit (a real track is returned
 * for the MBID search) and reach the transaction.
 */
import { discoverWeeklyService } from "../../discoverWeekly";
import { updateBatchStatus } from "../../discovery/optimisticBatchUpdate";
import { prisma } from "../../../utils/db";

jest.mock("../../discovery/optimisticBatchUpdate", () => ({
    updateBatchStatus: jest.fn().mockResolvedValue({ success: true, retries: 0 }),
}));

// buildFinalPlaylist (discoverWeekly.ts:868+) calls, before the $transaction:
//   prisma.discoveryBatch.findUnique (:871)   -- batch lookup + idempotency guard
//   prisma.downloadJob.findMany     (:887)    -- completed jobs -> searchCriteria
//   prisma.track.findMany           (:930)    -- MBID track search (returns a hit)
//   prisma.track.findMany           (:1180)   -- popular-library anchor fallback
// After the catch, cleanupFailedArtists (:1825) and cleanupOrphanedLidarrQueue
// (:1718) re-read prisma.discoveryBatch.findUnique and iterate batch.jobs, so
// the findUnique fixture MUST carry `jobs: []` or those post-catch calls throw
// an unrelated TypeError and the test would fail for the wrong reason.
jest.mock("../../../utils/db", () => ({
    prisma: {
        discoveryBatch: { findUnique: jest.fn(), update: jest.fn() },
        downloadJob: { findMany: jest.fn().mockResolvedValue([]) },
        track: { findMany: jest.fn().mockResolvedValue([]) },
        // Hoisted out of the $transaction by DISC-8, so it now runs against the
        // real (mocked) client before the transaction. Returns undefined -> the
        // service falls back to exclusionMonths=6, which these failure tests don't assert on.
        userDiscoverConfig: { findUnique: jest.fn() },
        $transaction: jest.fn(),
    },
}));

// The service imports discoveryBatchLogger + discoverySeeding from the barrel
// "./discovery". Mock the barrel itself so both bindings are intercepted (the
// barrel re-exports live bindings, but mocking it directly is unambiguous and
// keeps the test self-contained). getSeedArtists -> [] so the seed-anchor
// branch at :1111 is skipped; only the :1180 popular fallback runs.
jest.mock("../../discovery", () => ({
    discoveryBatchLogger: { info: jest.fn(), error: jest.fn() },
    discoverySeeding: { getSeedArtists: jest.fn().mockResolvedValue([]) },
    discoveryAlbumLifecycle: { processBeforeGeneration: jest.fn() },
}));

// cleanupFailedArtists (:1848) calls lidarrService.getDiscoveryArtists after the
// catch; cleanupOrphanedLidarrQueue (:1725) calls getSystemSettings. Both run
// on every buildFinalPlaylist exit path, so stub them to no-op/empty.
jest.mock("../../lidarr", () => ({
    lidarrService: {
        getDiscoveryArtists: jest.fn().mockResolvedValue([]),
    },
}));
jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue(null),
}));

// eventBus.emit (:1468) fires after the catch -- stub to avoid touching the
// real EventEmitter channel.
jest.mock("../../eventBus", () => ({
    eventBus: { emit: jest.fn() },
}));

// Import-time-only heavy deps (BullMQ queues instantiate at module load,
// lastfm/musicbrainz/acquisition pull network clients). Stub so the module
// graph loads without opening Redis/HTTP handles.
jest.mock("../../../workers/queues", () => ({
    scanQueue: { add: jest.fn() },
    discoverQueue: { add: jest.fn() },
}));
jest.mock("../../lastfm", () => ({ lastFmService: {} }));
jest.mock("../../musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../acquisitionService", () => ({ acquisitionService: {} }));
jest.mock("../../discoveryLogger", () => ({
    discoveryLogger: { info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../artistCountsService", () => ({
    updateArtistCounts: jest.fn(),
}));

describe("buildFinalPlaylist failure handling (Task 5)", () => {
    beforeEach(() => jest.clearAllMocks());

    // ---- FAILURE PATH (the reason this task exists) --------------------------
    it("marks the batch failed via the build-transaction CATCH, not the no-tracks short-circuit", async () => {
        // Batch is `scanning` so the :881 idempotency guard (completed/failed
        // only) does NOT short-circuit. jobs:[] keeps the post-catch cleanup
        // from throwing on `for (job of batch.jobs)`.
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-1",
            userId: "u1",
            status: "scanning",
            targetSongCount: 30,
            weekStart: new Date("2026-05-25T00:00:00.000Z"),
            jobs: [],
        });

        // A completed job with VALID metadata so searchCriteria survives the
        // `.filter(c => c.artistName && c.albumTitle)` at :910. metadata:{}
        // would empty searchCriteria -> 0 tracks -> the no-tracks short-circuit
        // (DIFFERENT errorMessage), which is exactly the wrong path to hit.
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "job-1",
                discoveryBatchId: "batch-1",
                status: "completed",
                metadata: {
                    artistName: "Test Artist",
                    albumTitle: "Test Album",
                    albumMbid: "mbid-123",
                },
            },
        ]);

        // The MBID track-search (:930) returns a real track, so allTracks is
        // non-empty: the method skips the :1039 no-tracks return and reaches
        // the $transaction. The same value is returned for the :1180 anchor
        // fallback (harmless -- it just pads anchors).
        (prisma.track.findMany as jest.Mock).mockResolvedValue([
            {
                id: "t1",
                title: "T",
                filePath: "/m/t1.flac",
                album: {
                    id: "alb-1",
                    rgMbid: "mbid-123",
                    title: "Test Album",
                    artist: { name: "Test Artist" },
                },
            },
        ]);

        // The transaction throws -> drives the CATCH at :1440.
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("constraint violation")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-1");

        // DISCRIMINATOR: errorMessage prefix "Playlist build failed:" is set
        // ONLY by the transaction catch. It can never be produced by the
        // no-tracks short-circuit ("No tracks found after scan"). This is the
        // assertion that proves the new behavior specifically.
        expect(updateBatchStatus).toHaveBeenCalledWith(
            "batch-1",
            expect.objectContaining({
                status: "failed",
                errorMessage: expect.stringContaining("Playlist build failed"),
            })
        );

        // Negative guard: ensure we did NOT reach here via the short-circuit.
        // If the fixture regressed into the no-tracks path, updateBatchStatus
        // would carry the wrong errorMessage and this would catch it.
        expect(updateBatchStatus).not.toHaveBeenCalledWith(
            "batch-1",
            expect.objectContaining({
                errorMessage: "No tracks found after scan",
            })
        );
    });

    // ---- TERMINAL STATE: completedAt MUST be set ----------------------------
    // Gap closed: a catch that sets `status:"failed"` + the right errorMessage
    // but OMITS `completedAt` passes every other assertion in this file, yet
    // leaves the batch without a terminal timestamp. That is the exact bug
    // Task 5 exists to kill: /batch-status (Task 3) selects the latest terminal
    // batch with `orderBy: completedAt desc` and `findFirst` skips null-ordered
    // rows in practice, so a null completedAt re-hides the failed batch and the
    // 30-min stuck sweep is back. Pin completedAt to a real Date.
    it("sets completedAt so the failed batch is a real terminal state, not a pending one", async () => {
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-terminal",
            userId: "u1",
            status: "scanning",
            targetSongCount: 30,
            weekStart: new Date("2026-05-25T00:00:00.000Z"),
            jobs: [],
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "job-terminal",
                discoveryBatchId: "batch-terminal",
                status: "completed",
                metadata: {
                    artistName: "Terminal Artist",
                    albumTitle: "Terminal Album",
                    albumMbid: "mbid-terminal",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([
            {
                id: "tt",
                title: "TT",
                filePath: "/m/tt.flac",
                album: {
                    id: "alb-terminal",
                    rgMbid: "mbid-terminal",
                    title: "Terminal Album",
                    artist: { name: "Terminal Artist" },
                },
            },
        ]);
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("constraint violation")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-terminal");

        expect(updateBatchStatus).toHaveBeenCalledWith(
            "batch-terminal",
            expect.objectContaining({
                status: "failed",
                completedAt: expect.any(Date),
            })
        );
    });

    // ---- NO RESURRECTION: failure path never writes status "completed" ------
    // Gap closed: every existing assertion uses toHaveBeenCalledWith, which
    // matches ANY call. A broken implementation that marks the batch `failed`
    // in the catch but then -- on a post-catch path or a future regression --
    // ALSO calls updateBatchStatus({status:"completed"}) would satisfy all the
    // failure-path assertions above while leaving the batch reading as a
    // successful empty week to Task 3's /current fallback (which queries
    // status:"completed"). Assert the failure path NEVER emits a completed
    // status.
    it("never marks the batch completed once the build transaction has thrown", async () => {
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-noresurrect",
            userId: "u1",
            status: "scanning",
            targetSongCount: 30,
            weekStart: new Date("2026-05-25T00:00:00.000Z"),
            jobs: [],
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "job-nr",
                discoveryBatchId: "batch-noresurrect",
                status: "completed",
                metadata: {
                    artistName: "NR Artist",
                    albumTitle: "NR Album",
                    albumMbid: "mbid-nr",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([
            {
                id: "tnr",
                title: "TNR",
                filePath: "/m/tnr.flac",
                album: {
                    id: "alb-nr",
                    rgMbid: "mbid-nr",
                    title: "NR Album",
                    artist: { name: "NR Artist" },
                },
            },
        ]);
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("constraint violation")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-noresurrect");

        // Not a single updateBatchStatus call may carry status:"completed".
        const completedCalls = (
            updateBatchStatus as jest.Mock
        ).mock.calls.filter(
            ([, data]) => data && data.status === "completed"
        );
        expect(completedCalls).toEqual([]);

        // And the batch was in fact transitioned to failed (sanity: the test is
        // exercising the catch, not silently passing because nothing happened).
        const failedCalls = (
            updateBatchStatus as jest.Mock
        ).mock.calls.filter(([, data]) => data && data.status === "failed");
        expect(failedCalls.length).toBeGreaterThanOrEqual(1);
    });

    // ---- SINGLE WRITER: failure path writes status exactly once -------------
    // Gap closed: nothing pins HOW MANY times the catch transitions the batch.
    // The :1043 no-tracks short-circuit (failed) and the catch (failed) are two
    // distinct failure writers; a regression that both short-circuits AND falls
    // through to the catch, or a catch placed outside the try so it double-fires,
    // would still satisfy toHaveBeenCalledWith. On the transaction-failure path
    // the batch must be marked failed exactly once (the catch), never twice.
    it("transitions the batch to failed exactly once on the transaction-failure path", async () => {
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-once",
            userId: "u1",
            status: "scanning",
            targetSongCount: 30,
            weekStart: new Date("2026-05-25T00:00:00.000Z"),
            jobs: [],
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "job-once",
                discoveryBatchId: "batch-once",
                status: "completed",
                metadata: {
                    artistName: "Once Artist",
                    albumTitle: "Once Album",
                    albumMbid: "mbid-once",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([
            {
                id: "tonce",
                title: "TONCE",
                filePath: "/m/tonce.flac",
                album: {
                    id: "alb-once",
                    rgMbid: "mbid-once",
                    title: "Once Album",
                    artist: { name: "Once Artist" },
                },
            },
        ]);
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("constraint violation")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-once");

        const failedCalls = (
            updateBatchStatus as jest.Mock
        ).mock.calls.filter(([, data]) => data && data.status === "failed");
        expect(failedCalls).toHaveLength(1);
    });

    // ---- EDGE: original error message is propagated -------------------------
    it("includes the underlying transaction error message in the failure reason", async () => {
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-2",
            userId: "u1",
            status: "scanning",
            targetSongCount: 30,
            weekStart: new Date("2026-05-25T00:00:00.000Z"),
            jobs: [],
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "job-2",
                discoveryBatchId: "batch-2",
                status: "completed",
                metadata: {
                    artistName: "Artist Two",
                    albumTitle: "Album Two",
                    albumMbid: "mbid-2",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([
            {
                id: "t2",
                title: "T2",
                filePath: "/m/t2.flac",
                album: {
                    id: "alb-2",
                    rgMbid: "mbid-2",
                    title: "Album Two",
                    artist: { name: "Artist Two" },
                },
            },
        ]);
        (prisma.$transaction as jest.Mock).mockRejectedValue(
            new Error("P2002 unique constraint failed")
        );

        await discoverWeeklyService.buildFinalPlaylist("batch-2");

        // The catch interpolates `${txError.message}` -- assert the specific
        // underlying cause is carried through, not swallowed.
        expect(updateBatchStatus).toHaveBeenCalledWith(
            "batch-2",
            expect.objectContaining({
                status: "failed",
                errorMessage: expect.stringContaining(
                    "P2002 unique constraint failed"
                ),
            })
        );
    });

    // ---- BOUNDARY: short-circuit path must NOT use the catch's message ------
    it("the no-tracks short-circuit stays distinct (does not borrow the catch errorMessage)", async () => {
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-3",
            userId: "u1",
            status: "scanning",
            targetSongCount: 30,
            weekStart: new Date("2026-05-25T00:00:00.000Z"),
            jobs: [],
        });
        // No completed jobs -> empty searchCriteria -> allTracks empty -> the
        // :1039 short-circuit fires BEFORE any $transaction. This is the OTHER
        // failure path; it must keep its own errorMessage so the two paths are
        // never conflated.
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);

        await discoverWeeklyService.buildFinalPlaylist("batch-3");

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(updateBatchStatus).toHaveBeenCalledWith(
            "batch-3",
            expect.objectContaining({
                status: "failed",
                errorMessage: "No tracks found after scan",
            })
        );
        // And it must NOT masquerade as the transaction failure.
        expect(updateBatchStatus).not.toHaveBeenCalledWith(
            "batch-3",
            expect.objectContaining({
                errorMessage: expect.stringContaining("Playlist build failed"),
            })
        );
    });

    // ---- HAPPY PATH (last) --------------------------------------------------
    it("does NOT mark the batch failed when the transaction succeeds", async () => {
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-4",
            userId: "u1",
            status: "scanning",
            targetSongCount: 30,
            weekStart: new Date("2026-05-25T00:00:00.000Z"),
            jobs: [],
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "job-4",
                discoveryBatchId: "batch-4",
                status: "completed",
                metadata: {
                    artistName: "Happy Artist",
                    albumTitle: "Happy Album",
                    albumMbid: "mbid-4",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([
            {
                id: "t4",
                title: "T4",
                filePath: "/m/t4.flac",
                album: {
                    id: "alb-4",
                    rgMbid: "mbid-4",
                    title: "Happy Album",
                    artist: { name: "Happy Artist" },
                },
            },
        ]);
        // Transaction resolves -> success path -> updateBatchStatus is called
        // INSIDE the transaction (with the tx client), not via the catch.
        (prisma.$transaction as jest.Mock).mockResolvedValue({
            albumCount: 1,
            trackCount: 1,
        });

        await discoverWeeklyService.buildFinalPlaylist("batch-4");

        // The failure catch must not have fired.
        expect(updateBatchStatus).not.toHaveBeenCalledWith(
            "batch-4",
            expect.objectContaining({
                errorMessage: expect.stringContaining("Playlist build failed"),
            })
        );
    });
});
