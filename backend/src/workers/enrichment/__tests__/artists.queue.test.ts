/**
 * What the artist job asks of the artist queue. Artists have no stage record, so
 * the job selects on `Artist.enrichmentStatus` with its own backoff: completed
 * jobs are cleaned at once, failed ones after a grace, and an artist is marked
 * "enriching" only once its job is really queued. Real database; the queue is
 * the adapter faked here (the lost-job case, which needs a real queue, is in
 * artists.lostJob.integration.test.ts).
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
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { queueOwedArtists } from "../artists";
import { prisma } from "../../../utils/db";

const P = "zz-artistQueue-";

async function wipe() {
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** A pending artist with one album at `location`. */
async function seedArtist(n: string, location: "LIBRARY" | "DISCOVER" = "LIBRARY") {
    const id = `${P}${n}`;
    await prisma.artist.create({ data: { id, name: `Artist ${n}`, identityKey: id } });
    await prisma.album.create({
        data: { id: `${P}album-${n}`, rgMbid: `${P}rg-${n}`, artistId: id, title: `Album ${n}`, primaryType: "Album", location },
    });
    return id;
}

const statusOf = async (id: string) => (await prisma.artist.findUniqueOrThrow({ where: { id } })).enrichmentStatus;
const queuedIds = () => mockArtistAdd.mock.calls.map((c) => (c[1] as { artistId: string }).artistId);

// clean(grace, limit, type)
const cleanCallsFor = (type: string) => mockArtistClean.mock.calls.filter((c) => c[2] === type);

describe("queueOwedArtists", () => {
    beforeAll(wipe);
    afterAll(wipe);
    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        mockArtistAdd.mockResolvedValue({ id: "j" });
        mockArtistClean.mockResolvedValue([]);
        mockArtistGetJob.mockResolvedValue(null);
        // A job is still queued, so no artist marked enriching is taken for a lost one.
        mockArtistGetJobCounts.mockResolvedValue({ waiting: 1, active: 0, delayed: 0, prioritized: 0 });
    });

    it("cleans completed (grace 0) and failed (grace > 0) before queuing", async () => {
        const id = await seedArtist("1");

        await queueOwedArtists();

        const completed = cleanCallsFor("completed");
        const failed = cleanCallsFor("failed");
        expect(completed).toHaveLength(1);
        expect(completed[0][0]).toBe(0); // immediate reuse on success
        expect(failed).toHaveLength(1);
        expect(failed[0][0]).toBeGreaterThan(0); // backoff grace before retry
        expect(mockArtistAdd).toHaveBeenCalledWith("enrich", { artistId: id, artistName: "Artist 1" }, { jobId: `artist-${id}` });
        expect(mockArtistClean.mock.invocationCallOrder[0]).toBeLessThan(mockArtistAdd.mock.invocationCallOrder[0]);
    });

    it("marks an artist enriching only after its job is queued", async () => {
        const id = await seedArtist("1");
        // What the stored row says at the moment the job is queued.
        const statusWhenQueued: Record<string, string> = {};
        mockArtistAdd.mockImplementation(async (_name: string, data: { artistId: string }) => {
            statusWhenQueued[data.artistId] = await statusOf(data.artistId);
            return { id: "j" };
        });

        await queueOwedArtists();

        expect(statusWhenQueued[id]).toBe("pending");
        expect(await statusOf(id)).toBe("enriching");
    });

    it("a queue that refuses the job leaves the artist pending", async () => {
        const id = await seedArtist("1");
        mockArtistAdd.mockRejectedValue(new Error("redis down"));

        await queueOwedArtists();

        expect(await statusOf(id)).toBe("pending");
    });

    it("backs off (does not re-add or park) when the jobId slot is still held", async () => {
        // A failed job younger than the grace still holds the jobId; getJob returns it, so the
        // artist is skipped -- not re-added, not parked out of selection.
        const id = await seedArtist("1");
        mockArtistGetJob.mockResolvedValue({ id: `artist-${id}` });

        await queueOwedArtists();

        expect(mockArtistAdd).not.toHaveBeenCalled();
        expect(await statusOf(id)).toBe("pending");
    });

    it("asks only for library artists, a batch at a time", async () => {
        const discoverOnly = await seedArtist("discover", "DISCOVER");
        for (let i = 0; i < 12; i++) await seedArtist(String(i));

        const queued = await queueOwedArtists();

        expect(queued).toBe(10);
        expect(mockArtistAdd).toHaveBeenCalledTimes(10);
        expect(queuedIds()).not.toContain(discoverOnly);
        expect(await statusOf(discoverOnly)).toBe("pending");
    });

    it("no work for an artist that is not owed: no queue", async () => {
        const id = await seedArtist("1");
        await prisma.artist.update({ where: { id }, data: { enrichmentStatus: "completed" } });

        await queueOwedArtists();

        expect(queuedIds()).not.toContain(id);
    });
});
