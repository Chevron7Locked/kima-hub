/**
 * Text search returns the `limit` nearest tracks, best first, with no cosine
 * floor: text-to-audio cosines are only comparable within one query.
 */
import { prisma } from "../../utils/db";
import { searchTracksByEmbedding } from "../textEmbeddingBridge";
import { insertEmbeddings, unitVectorAt, unitVectorValues } from "../../__tests__/helpers/embeddingFixtures";

const QUERY = unitVectorValues(1, 1);
// Every seeded track scores below 0.40; the order must still hold.
const SEEDS: Array<[string, number]> = [
    ["low", 0.1],
    ["best", 0.35],
    ["mid", 0.25],
];

beforeAll(async () => {
    // Earlier suites in this worker leave thousands of deleted vectors in the HNSW index until a vacuum, and the
    // approximate search below then misses some of the nearest live ones.
    await prisma.$executeRawUnsafe(`VACUUM track_embeddings`);
    const artist = await prisma.artist.create({
        data: { id: "art_ts_1", name: "TS Artist", identityKey: "a_ts_1" },
    });
    const album = await prisma.album.create({
        data: {
            id: "alb_ts_1",
            rgMbid: "rg_ts_1",
            artistId: artist.id,
            title: "TS Album",
            primaryType: "Album",
        },
    });
    for (const [i, [name, cos]] of SEEDS.entries()) {
        const id = `trk_ts_${name}`;
        await prisma.track.create({
            data: {
                id,
                albumId: album.id,
                title: `T ${name}`,
                trackNo: i + 1,
                duration: 200,
                filePath: `/tmp/ts_${name}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            },
        });
        await insertEmbeddings([{ trackId: id, vector: unitVectorAt(cos, i + 2) }]);
    }
});

afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_ts\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, "alb\\_ts\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, "art\\_ts\\_%");
    await prisma.$disconnect();
});

describe("searchTracksByEmbedding", () => {
    it("returns the nearest tracks best-first even when every cosine is below 0.40", async () => {
        const rows = (await searchTracksByEmbedding(QUERY, 100)).filter((r) =>
            r.id.startsWith("trk_ts_"),
        );
        expect(rows.map((r) => r.id)).toEqual(["trk_ts_best", "trk_ts_mid", "trk_ts_low"]);
        expect(1 - rows[0].distance).toBeCloseTo(0.35, 5);
        expect(rows[0]).toMatchObject({
            title: "T best",
            trackNo: 2,
            duration: 200,
            albumId: "alb_ts_1",
            albumTitle: "TS Album",
            artistId: "art_ts_1",
            artistName: "TS Artist",
        });
    });

    it("caps the result at limit", async () => {
        const rows = await searchTracksByEmbedding(QUERY, 2);
        expect(rows).toHaveLength(2);
    });
});
