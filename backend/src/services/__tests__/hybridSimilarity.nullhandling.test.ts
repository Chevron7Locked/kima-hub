/**
 * With CLAP embeddings, similar tracks rank on the matching formula, which the audio feature columns do not enter.
 * Without the CLAP analyzer there are none. A seed with no embedding returns no rows.
 */

import { prisma } from "../../utils/db";
import { featureDetection } from "../../services/featureDetection";
import { findSimilarTracks } from "../hybridSimilarity";
import { buildMatching } from "../matching/state";
import { seedEmbedding, unitVectorAt } from "../../__tests__/helpers/embeddingFixtures";

jest.mock("../../services/featureDetection", () => ({
    featureDetection: { getFeatures: jest.fn() },
}));

const mockGetFeatures = featureDetection.getFeatures as unknown as jest.Mock;

function setMode(mode: "hybrid" | "featuresOnly") {
    mockGetFeatures.mockResolvedValue({
        musicCNN: mode === "hybrid" || mode === "featuresOnly",
        vibeEmbeddings: mode === "hybrid",
        audiobookshelfEnabled: false,
    });
}

async function seedTrack(id: string, over: Record<string, unknown>) {
    const artist = await prisma.artist.create({
        data: { id: `art_hs_${id}`, name: `A ${id}`, identityKey: `a_hs_${id}` },
    });
    const album = await prisma.album.create({
        data: {
            id: `alb_hs_${id}`,
            rgMbid: `rg_hs_${id}`,
            artistId: artist.id,
            title: `L ${id}`,
            primaryType: "Album",
        },
    });
    await prisma.track.create({
        data: {
            id: `trk_hs_${id}`,
            albumId: album.id,
            title: `T ${id}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/hs_${id}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            ...over,
        },
    });
}

afterAll(async () => {
    // Prefix-scoped cleanup, children first. The trk_/alb_/art_ prefixes are
    // shared with other suites, so anchor on the hs_ middle segment; the
    // underscore is escaped because LIKE treats bare _ as a wildcard.
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_hs\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, "alb\\_hs\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, "art\\_hs\\_%");
    await prisma.$disconnect();
});

// pgvector computes in float32, so scores carry ~1e-6 noise: assertions use 5-decimal closeness.

describe("hybridSimilarity null handling (DB, shipped functions)", () => {
    beforeAll(() => {
        mockGetFeatures.mockResolvedValue({
            musicCNN: true,
            vibeEmbeddings: true,
            audiobookshelfEnabled: false,
        });
    });

    it("CLAP present: the audio feature columns do not move the ranking", async () => {
        setMode("hybrid");
        const src = {
            energy: 0.0, valence: 0.0, arousal: 0.0, bpm: 60,
            danceabilityMl: 0.0, acousticness: 0.0, instrumentalness: 0.0,
            key: "C", keyScale: "major",
        };
        const opposite = {
            energy: 1.0, valence: 1.0, arousal: 1.0, bpm: 97,
            danceabilityMl: 1.0, acousticness: 1.0, instrumentalness: 1.0,
            key: "F#", keyScale: "minor",
        };
        await seedTrack("fp_src", src);
        await seedTrack("fp_near", opposite);
        await seedTrack("fp_far", { ...src });
        await seedEmbedding("trk_hs_fp_src", unitVectorAt(1, 1));
        await seedEmbedding("trk_hs_fp_near", unitVectorAt(0.95, 2));
        await seedEmbedding("trk_hs_fp_far", unitVectorAt(0.9, 3));
        await buildMatching();

        const before = await findSimilarTracks("trk_hs_fp_src", 10);
        expect(before.map((r) => r.id)).toEqual(expect.arrayContaining(["trk_hs_fp_near", "trk_hs_fp_far"]));
        for (const r of before) {
            expect(r.distance).toBeCloseTo(1 - r.similarity, 5);
        }

        // Swap the two candidates' audio features: nothing the formula reads changes.
        await prisma.track.update({ where: { id: "trk_hs_fp_near" }, data: { ...src } });
        await prisma.track.update({ where: { id: "trk_hs_fp_far" }, data: { ...opposite } });
        expect(await findSimilarTracks("trk_hs_fp_src", 10)).toEqual(before);
    });

    it("without the CLAP analyzer there are no similar tracks", async () => {
        setMode("featuresOnly");
        await seedTrack("noclap", { energy: 0.5 });
        expect(await findSimilarTracks("trk_hs_noclap", 10)).toEqual([]);
        setMode("hybrid");
    });
});

// A seed with no embedding row returns [], which the routes turn into their
// "not analysed yet" 404.
describe("unanalysed seed (no embedding row) returns no rows", () => {
    it("CLAP mode: a seed track with no embedding row returns []", async () => {
        setMode("hybrid");
        // One embedded neighbour shows the empty result comes from the seed's missing
        // embedding, not from an empty library.
        await seedTrack("un_src", {});
        await seedTrack("un_nb", {});
        await seedEmbedding("trk_hs_un_nb", unitVectorAt(1, 1));
        await buildMatching();

        const rows = await findSimilarTracks("trk_hs_un_src", 10);
        expect(rows).toEqual([]);
    });

    it("CLAP mode: a nonexistent track id returns []", async () => {
        setMode("hybrid");
        await seedTrack("un_nb2", {});
        await seedEmbedding("trk_hs_un_nb2", unitVectorAt(1, 1));
        await buildMatching();

        const rows = await findSimilarTracks("ctrk_hs_does_not_exist", 10);
        expect(rows).toEqual([]);
    });
});
