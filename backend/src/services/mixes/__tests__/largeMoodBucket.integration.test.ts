/**
 * A mood bucket larger than one query can send as bound ids, on a real Postgres.
 *
 * Postgres accepts at most 65,535 bound values in one query. The custom mood mix
 * matches the bucket in the database rather than reading every bucket row and
 * sending the track ids back as `id: { in: [...] }`, which fails once a bucket
 * passes that. Here one bucket holds 70,000 tracks.
 */
import { prisma } from "../../../utils/db";
import { generateMoodOnDemand } from "../moodMixes";

jest.setTimeout(300_000);

const PREFIX = "lmb_";
const TRACKS = 70_000;

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({
        data: { id: `${PREFIX}art`, name: "Bucket Artist", normalizedName: "bucket artist", identityKey: `${PREFIX}ak` },
    });
    await prisma.album.create({
        data: { id: `${PREFIX}alb`, rgMbid: `${PREFIX}rg`, artistId: `${PREFIX}art`, identityKey: `${PREFIX}ik`, title: "Bucket Album", primaryType: "Album" },
    });
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", "analysisStatus", energy, "updatedAt")
        SELECT ${PREFIX + "trk_"} || lpad(i::text, 6, '0'), ${PREFIX + "alb"}, 'Bucket Track ' || i, 1, 200,
               '/tmp/' || ${PREFIX} || i || '.flac', now(), 1000, 'completed', 0.3, now()
        FROM generate_series(0, ${TRACKS - 1}) AS i`;
    await prisma.$executeRaw`
        INSERT INTO "MoodBucket" (id, "trackId", mood, score, "updatedAt")
        SELECT ${PREFIX + "mb_"} || t.id, t.id, 'chill', 0.5, now()
        FROM "Track" t WHERE t.id LIKE ${PREFIX + "%"}`;
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe(`a "chill" bucket of ${TRACKS} tracks`, () => {
    it("sending its ids back in one query is refused (the problem)", async () => {
        const ids = (await prisma.moodBucket.findMany({ where: { mood: "chill" }, select: { trackId: true } })).map((b) => b.trackId);
        expect(ids.length).toBeGreaterThanOrEqual(TRACKS);
        await expect(prisma.track.findMany({ where: { id: { in: ids } }, select: { id: true }, take: 5 })).rejects.toThrow();
    });

    it("still makes a custom mood mix from it", async () => {
        const mix = await generateMoodOnDemand("unused", { mood: "chill" });
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(15);
    });
});
