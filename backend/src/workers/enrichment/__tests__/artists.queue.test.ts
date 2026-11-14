/**
 * What the artist job asks of the artist queue. Artists have no stage record, so
 * the job selects on `Artist.enrichmentStatus` with its own backoff: completed
 * jobs are cleaned at once, failed ones after a grace, and an artist is marked
 * "enriching" only once its job is really queued.
 */

const mockArtistAdd = jest.fn().mockResolvedValue({ id: "j" });
const mockArtistClean = jest.fn().mockResolvedValue([]);
const mockArtistGetJob = jest.fn().mockResolvedValue(null);
const mockArtistGetJobCounts = jest.fn();

jest.mock("../../enrichmentQueues", () => ({
    QUEUE_NAMES: { ARTISTS: "enrichment-artists" },
    artistQueue: {
        add: mockArtistAdd,
        clean: mockArtistClean,
        getJob: mockArtistGetJob,
        getJobCounts: mockArtistGetJobCounts,
    },
    createWorkerConnection: jest.fn(),
}));

const mockArtistFindMany = jest.fn();
const mockArtistUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockArtistUpdate = jest.fn().mockResolvedValue({});

jest.mock("../../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: mockArtistFindMany,
            updateMany: mockArtistUpdateMany,
            update: mockArtistUpdate,
        },
    },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { queueOwedArtists } from "../artists";

// clean(grace, limit, type)
const cleanCallsFor = (mock: jest.Mock, type: string) =>
    mock.mock.calls.filter((c) => c[2] === type);

describe("queueOwedArtists", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistGetJob.mockResolvedValue(null);
        mockArtistGetJobCounts.mockResolvedValue({ waiting: 1, active: 0, delayed: 0, prioritized: 0 });
        mockArtistFindMany.mockResolvedValue([{ id: "a1", name: "Artist One" }]);
    });

    it("cleans completed (grace 0) and failed (grace > 0) before queuing", async () => {
        const queued = await queueOwedArtists();

        const completed = cleanCallsFor(mockArtistClean, "completed");
        const failed = cleanCallsFor(mockArtistClean, "failed");
        expect(completed).toHaveLength(1);
        expect(completed[0][0]).toBe(0); // immediate reuse on success
        expect(failed).toHaveLength(1);
        expect(failed[0][0]).toBeGreaterThan(0); // backoff grace before retry
        expect(mockArtistAdd).toHaveBeenCalledWith(
            "enrich",
            { artistId: "a1", artistName: "Artist One" },
            { jobId: "artist-a1" },
        );
        expect(queued).toBe(1);
    });

    it("marks an artist enriching only after its job is queued", async () => {
        await queueOwedArtists();
        expect(mockArtistUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { enrichmentStatus: "enriching" } });
        expect(mockArtistAdd.mock.invocationCallOrder[0]).toBeLessThan(mockArtistUpdate.mock.invocationCallOrder[0]);
    });

    it("a queue that refuses the job leaves the artist pending", async () => {
        mockArtistAdd.mockRejectedValueOnce(new Error("redis down"));
        expect(await queueOwedArtists()).toBe(0);
        expect(mockArtistUpdate).not.toHaveBeenCalled();
    });

    it("backs off (does not re-add or park) when the jobId slot is still held", async () => {
        // A failed job younger than the grace still holds the jobId; getJob returns it, so the
        // artist is skipped -- not re-added, not parked out of selection.
        mockArtistGetJob.mockResolvedValue({ id: "artist-a1" });

        await queueOwedArtists();

        expect(mockArtistAdd).not.toHaveBeenCalled();
        expect(mockArtistUpdate).not.toHaveBeenCalled();
    });

    it("an artist left enriching with nothing queued or running is asked again", async () => {
        mockArtistGetJobCounts.mockResolvedValueOnce({ waiting: 0, active: 0, delayed: 0, prioritized: 0 });
        await queueOwedArtists();
        expect(mockArtistUpdateMany).toHaveBeenCalledWith({
            where: { enrichmentStatus: "enriching" },
            data: { enrichmentStatus: "pending" },
        });
    });

    it("while jobs are queued, enriching artists are left alone", async () => {
        await queueOwedArtists();
        expect(mockArtistUpdateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { enrichmentStatus: "enriching" } }),
        );
    });

    it("asks only for library artists, a batch at a time", async () => {
        await queueOwedArtists();
        const query = mockArtistFindMany.mock.calls[0][0];
        expect(query.where.albums).toEqual({ some: { location: "LIBRARY" } });
        expect(query.take).toBe(10);
    });

    it("no work: no clean, no queue", async () => {
        mockArtistFindMany.mockResolvedValue([]);

        expect(await queueOwedArtists()).toBe(0);

        expect(mockArtistClean).not.toHaveBeenCalled();
        expect(mockArtistAdd).not.toHaveBeenCalled();
    });
});
