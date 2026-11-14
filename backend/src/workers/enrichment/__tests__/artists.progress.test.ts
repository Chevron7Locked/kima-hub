/**
 * The artist job answers "how far along are the artists, and are any still owed" through `artistProgress`, so the
 * scheduler's progress readout and the artists' own queue agree on which artists count: those with a library album.
 * Real database; the counts are read before and after seeding, so rows from elsewhere do not matter.
 */

import { prisma } from "../../../utils/db";
import { artistProgress } from "../artists";

jest.mock("../../enrichmentQueues", () => ({
    artistQueue: { getJobCounts: jest.fn(), add: jest.fn() },
    QUEUE_NAMES: { ARTISTS: "enrichment-artists" },
    createWorkerConnection: jest.fn(),
}));

const PREFIX = "artprog";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedArtist(name: string, enrichmentStatus: string, location: "LIBRARY" | "DISCOVER" | null) {
    await prisma.artist.create({ data: { id: id(name), name, identityKey: id(name), enrichmentStatus } });
    if (location) {
        await prisma.album.create({
            data: {
                id: id(`alb_${name}`),
                rgMbid: id(`rg_${name}`),
                artistId: id(name),
                title: name,
                identityKey: id(`k_${name}`),
                primaryType: "Album",
                location,
            },
        });
    }
}

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}_%`);
}

beforeEach(wipe);
afterAll(wipe);

it("counts the artists with a library album by status, and what is still owed", async () => {
    const before = await artistProgress();

    await seedArtist("done", "completed", "LIBRARY");
    await seedArtist("gave_up", "unresolvable", "LIBRARY");
    await seedArtist("waiting", "pending", "LIBRARY");
    await seedArtist("running", "enriching", "LIBRARY");
    await seedArtist("retry", "failed", "LIBRARY");
    // Known only from Discover, or from no album: not enriched, so not counted.
    await seedArtist("discover_only", "pending", "DISCOVER");
    await seedArtist("no_album", "pending", null);

    const after = await artistProgress();

    expect(after.total - before.total).toBe(5);
    expect(after.completed - before.completed).toBe(2);
    expect(after.pending - before.pending).toBe(1);
    expect(after.failed - before.failed).toBe(1);
    // Waiting, in flight, and failed-and-due: unresolvable and completed are not owed.
    expect(after.owed - before.owed).toBe(3);
});

it("reports the share of library artists that are done as a whole percent", async () => {
    await seedArtist("one", "completed", "LIBRARY");
    await seedArtist("two", "pending", "LIBRARY");
    const { total, completed, progress } = await artistProgress();

    expect(progress).toBe(total > 0 ? Math.round((completed / total) * 100) : 0);
});
