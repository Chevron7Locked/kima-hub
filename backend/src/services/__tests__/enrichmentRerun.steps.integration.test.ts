/**
 * A re-run from each of the five steps redoes that step and everything that
 * depends on it -- and nothing else. The vibe map is always laid out again;
 * person-decided answers and everything people made stay.
 */
import { prisma } from "../../utils/db";
import { rerunEnrichment } from "../enrichmentRestart";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "crerun";

async function seedEnrichedTrack(id: string, withVector: boolean) {
    await prisma.track.create({
        data: {
            id, albumId: `${P}alb`, title: `Track ${id}`, trackNo: 1, duration: 200,
            filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
            bpm: 120, energy: 0.8, valence: 0.4, moodTags: ["happy"], essentiaGenres: ["rock"],
            analysisStatus: "completed", analysisVersion: "v", analyzedAt: new Date(),
            vibeAnalysisStatus: "completed", recordingMbid: `${P}-rec`,
        },
    });
    for (const stage of ["recording", "analysis", "embedding"]) {
        await prisma.trackStage.create({
            data: { id: `${id}__${stage}`, trackId: id, stage, status: "done", attempt: 1, retryable: false },
        });
    }
    if (withVector) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())`,
            id, `[${Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`,
        );
    }
}

async function mapAndStateGone(): Promise<boolean> {
    const state = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM matching_state`);
    const map = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM matching_map`);
    return state[0].n === 0 && map[0].n === 0;
}

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
    await prisma.$executeRawUnsafe(`DELETE FROM "EnrichmentFailure" WHERE "entityId" LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({
        data: {
            id: `${P}art`, name: "Rerun One", identityKey: `${P}-1`, summary: "A bio",
            genres: ["rock"], lastEnriched: new Date(), enrichmentStatus: "completed",
        },
    });
    await prisma.artist.create({ data: { id: `${P}art2`, name: "Rerun Two", identityKey: `${P}-2` } });
    await prisma.similarArtist.create({ data: { fromArtistId: `${P}art`, toArtistId: `${P}art2` } });
    await prisma.album.create({
        data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Rerun Album", primaryType: "Album" },
    });
    await seedEnrichedTrack(`${P}trk`, true);
    await prisma.$executeRawUnsafe(
        `INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out)
         SELECT track_id, analyzed_at, 1, 2, 3, 0.5, true FROM track_embeddings WHERE track_id = $1`, `${P}trk`,
    );
    await prisma.$executeRawUnsafe(
        `INSERT INTO matching_state (id, version, fingerprint, "trackCount", "feelMeanValence", "feelMeanArousal",
             "feelSdValence", "feelSdArousal", "soundSpread", "genreSpread", "genreWeight", genres)
         VALUES ('default', 'v', 'f', 1, 0.5, 0.5, 0.1, 0.1, 0.9, 0.5, 0.2, '{}'::jsonb)`,
    );
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await closeEngineConnections();
});

describe("a similarity re-run", () => {
    it("clears the matching state and every stored position, and nothing else", async () => {
        await rerunEnrichment("similarity");
        expect(await mapAndStateGone()).toBe(true);
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}trk` } });
        expect(t).toMatchObject({
            bpm: 120, analysisStatus: "completed", vibeAnalysisStatus: "completed", recordingMbid: `${P}-rec`,
        });
        expect((await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM track_embeddings WHERE track_id = $1`, `${P}trk`,
        ))[0].n).toBe(1);
        const a = await prisma.artist.findUniqueOrThrow({ where: { id: `${P}art` } });
        expect(a).toMatchObject({ summary: "A bio", enrichmentStatus: "completed" });
        expect(await prisma.similarArtist.count({ where: { fromArtistId: `${P}art` } })).toBe(1);
    });
});

describe("an artists re-run", () => {
    it("clears artists and the map, keeps analysis, vectors and identification", async () => {
        await prisma.$executeRawUnsafe(
            `INSERT INTO matching_state (id, version, fingerprint, "trackCount", "feelMeanValence", "feelMeanArousal",
                 "feelSdValence", "feelSdArousal", "soundSpread", "genreSpread", "genreWeight", genres)
             VALUES ('default', 'v', 'f', 1, 0.5, 0.5, 0.1, 0.1, 0.9, 0.5, 0.2, '{}'::jsonb)`,
        );
        await rerunEnrichment("artists");
        const a = await prisma.artist.findUniqueOrThrow({ where: { id: `${P}art` } });
        expect(a).toMatchObject({ summary: null, genres: null, lastEnriched: null, enrichmentStatus: "pending" });
        expect(await prisma.similarArtist.count({ where: { fromArtistId: `${P}art` } })).toBe(0);
        expect(await mapAndStateGone()).toBe(true);
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}trk` } });
        expect(t).toMatchObject({ bpm: 120, analysisStatus: "completed", vibeAnalysisStatus: "completed", recordingMbid: `${P}-rec` });
        const stages = await prisma.trackStage.findMany({ where: { trackId: `${P}trk`, stage: "recording" } });
        expect(stages[0].status).toBe("done");
    });
});

describe("a vectors re-run", () => {
    it("clears sound vectors and the map, keeps analysis and identification", async () => {
        await seedEnrichedTrack(`${P}decided`, false);
        await prisma.trackStage.update({
            where: { id: `${P}decided__embedding` },
            data: { status: "blocked", decidedAt: new Date(), decidedBy: "resolved-via-failures-api" },
        });
        await rerunEnrichment("vectors");
        expect((await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM track_embeddings WHERE track_id = $1`, `${P}trk`,
        ))[0].n).toBe(0);
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}trk` } });
        expect(t).toMatchObject({ bpm: 120, analysisStatus: "completed", vibeAnalysisStatus: "pending", recordingMbid: `${P}-rec` });
        const embeddingStage = await prisma.trackStage.findUniqueOrThrow({ where: { id: `${P}trk__embedding` } });
        expect(embeddingStage.status).toBe("pending");
        const analysisStage = await prisma.trackStage.findUniqueOrThrow({ where: { id: `${P}trk__analysis` } });
        expect(analysisStage.status).toBe("done");
        expect(await mapAndStateGone()).toBe(true);
    });

    it("leaves a sound vector a person set aside as they left it", async () => {
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())`,
            `${P}decided`, `[${Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`,
        );
        const stage = await prisma.trackStage.findUniqueOrThrow({ where: { id: `${P}decided__embedding` } });
        expect(stage.decidedAt).not.toBeNull();
        await rerunEnrichment("vectors");
        expect((await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM track_embeddings WHERE track_id = $1`, `${P}decided`,
        ))[0].n).toBe(1);
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}decided` } });
        expect(t.vibeAnalysisStatus).toBe("completed");
    });
});

describe("an analysis re-run", () => {
    it("clears analysis and the vectors that depend on it, keeps identification", async () => {
        // Give the track a fresh vector and completed vibe status again.
        await prisma.track.update({
            where: { id: `${P}trk` },
            data: { vibeAnalysisStatus: "completed" },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())`,
            `${P}trk`, `[${Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`,
        );
        await rerunEnrichment("analysis");
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}trk` } });
        expect(t).toMatchObject({ bpm: null, analysisStatus: "pending", vibeAnalysisStatus: "pending", recordingMbid: `${P}-rec` });
        expect((await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM track_embeddings WHERE track_id = $1`, `${P}trk`,
        ))[0].n).toBe(0);
        const recordingStage = await prisma.trackStage.findUniqueOrThrow({ where: { id: `${P}trk__recording` } });
        expect(recordingStage.status).toBe("done");
        expect(await mapAndStateGone()).toBe(true);
    });
});

describe("an identification re-run", () => {
    it("asks every recording again and redoes everything after it, keeping a person's decision and a file's ISRC", async () => {
        await prisma.track.update({ where: { id: `${P}trk` }, data: { isrc: "GBAYE0601498", isrcSource: "musicbrainz" } });
        await seedEnrichedTrack(`${P}tagged`, false);
        await prisma.track.update({ where: { id: `${P}tagged` }, data: { isrc: "USRC17607839", isrcSource: "id3" } });
        await seedEnrichedTrack(`${P}chosen`, false);
        await prisma.trackStage.update({
            where: { id: `${P}chosen__recording` },
            data: { status: "blocked", decidedAt: new Date(), decidedBy: "resolved-via-failures-api" },
        });

        await rerunEnrichment("identification");

        const asked = await prisma.track.findUniqueOrThrow({ where: { id: `${P}trk` } });
        expect(asked).toMatchObject({ recordingMbid: null, isrc: null, isrcSource: null, analysisStatus: "pending", vibeAnalysisStatus: "pending" });
        expect((await prisma.trackStage.findUniqueOrThrow({ where: { id: `${P}trk__recording` } })).status).toBe("pending");

        const tagged = await prisma.track.findUniqueOrThrow({ where: { id: `${P}tagged` } });
        expect(tagged).toMatchObject({ recordingMbid: null, isrc: "USRC17607839", isrcSource: "id3" });

        const chosen = await prisma.track.findUniqueOrThrow({ where: { id: `${P}chosen` } });
        expect(chosen.recordingMbid).toBe(`${P}-rec`);
        expect((await prisma.trackStage.findUniqueOrThrow({ where: { id: `${P}chosen__recording` } })).status).toBe("blocked");

        const a = await prisma.artist.findUniqueOrThrow({ where: { id: `${P}art` } });
        expect(a.enrichmentStatus).toBe("pending");
        expect(await mapAndStateGone()).toBe(true);
    });
});
