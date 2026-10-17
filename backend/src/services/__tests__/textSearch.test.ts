/**
 * Text search returns the `limit` nearest tracks, best first, with no cosine
 * floor: text-to-audio cosines are only comparable within one query.
 */
import { prisma } from "../../utils/db";
import { searchTracksByEmbedding } from "../textEmbeddingBridge";

// Unit 512-dim vector with cosine `cos` to the axis-0 unit vector.
function unitVectorAt(cos: number, axis: number): number[] {
    const v = Array(512).fill(0);
    v[0] = cos;
    v[axis] = Math.sqrt(1 - cos * cos);
    return v;
}

const QUERY = unitVectorAt(1, 1);
// Every seeded track scores below 0.40; the order must still hold.
const SEEDS: Array<[string, number]> = [
    ["low", 0.1],
    ["best", 0.35],
    ["mid", 0.25],
];

beforeAll(async () => {
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
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())`,
            id,
            `[${unitVectorAt(cos, i + 2).join(",")}]`,
        );
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
