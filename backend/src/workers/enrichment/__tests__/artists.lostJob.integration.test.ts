/**
 * An artist left "enriching" after its job was lost (Redis emptied, a crash) is
 * asked again, and only then: while the artist queue still holds a job, the
 * mark stands. Real database, real queue.
 */

import { prisma } from "../../../utils/db";
import { artistQueue } from "../../enrichmentQueues";
import { queueOwedArtists } from "../artists";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const ARTIST = "lostjob_artist";

async function stuckArtist() {
    await prisma.artist.create({
        data: { id: ARTIST, name: "Lost Job Artist", identityKey: ARTIST, enrichmentStatus: "enriching" },
    });
}

const status = async () => (await prisma.artist.findUniqueOrThrow({ where: { id: ARTIST } })).enrichmentStatus;

beforeEach(async () => {
    await artistQueue.obliterate({ force: true });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
});

afterAll(async () => {
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await closeEngineConnections();
});

it("asks an artist again when its job is gone from an empty queue", async () => {
    await stuckArtist();
    await queueOwedArtists();
    expect(await status()).toBe("pending");
});

it("leaves the mark while the queue still holds an artist job", async () => {
    await stuckArtist();
    await artistQueue.add("enrich", { artistId: "someone_else", artistName: "Someone Else" }, { jobId: "artist-someone_else" });
    await queueOwedArtists();
    expect(await status()).toBe("enriching");
});
