/**
 * Wiping the enrichment clears what the five enrichment steps worked out and nothing else: the library, which
 * recording and artist each file is, artist images, user edits, playlists, plays and likes stay.
 */
import { prisma } from "../../utils/db";
import { wipeEnrichment } from "../enrichmentRestart";
import { redisClient } from "../../utils/redis";
import { trackQueue, vibeQueue } from "../../workers/enrichmentQueues";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "cwipe";

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
    await prisma.$executeRawUnsafe(`DELETE FROM "EnrichmentFailure" WHERE "entityId" LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Playlist" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Genre" WHERE name LIKE '${P}%'`);
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({
        data: {
            id: `${P}art1`, name: "Wipe One", identityKey: `${P}-1`, mbid: `${P}-mbid-1`,
            summary: "An old bio", genres: ["rock"], similarArtistsJson: [{ name: "Wipe Two" }],
            heroUrl: "/images/one.jpg", userSummary: "My own words", hasUserOverrides: true,
            lastEnriched: new Date(), enrichmentStatus: "completed",
        },
    });
    await prisma.artist.create({ data: { id: `${P}art2`, name: "Wipe Two", identityKey: `${P}-2` } });
    await prisma.similarArtist.create({ data: { fromArtistId: `${P}art1`, toArtistId: `${P}art2` } });
    await prisma.album.create({
        data: { id: `${P}alb`, artistId: `${P}art1`, rgMbid: `${P}-rg`, title: "Wipe Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: `${P}trk`, albumId: `${P}alb`, title: "Wipe Track", trackNo: 1, duration: 200,
            filePath: `/tmp/${P}.flac`, fileModified: new Date(), fileSize: 1000,
            bpm: 120, energy: 0.8, valence: 0.4, moodHappy: 0.9, moodTags: ["happy"], essentiaGenres: ["rock"],
            analysisStatus: "completed", analysisVersion: "2.1b6-enhanced-v3", analyzedAt: new Date(),
            vibeAnalysisStatus: "completed", recordingMbid: `${P}-rec`, acoustidFingerprint: "AQAA",
            isrc: "GBAYE0601498", isrcSource: "musicbrainz", displayTitle: "My Title", hasUserOverrides: true,
        },
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())`,
        `${P}trk`, `[${Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`,
    );
    await prisma.$executeRawUnsafe(
        `INSERT INTO matching_feel (track_id, embedded_at, probe, valence, arousal)
         SELECT track_id, analyzed_at, 'p', 0.5, 0.5 FROM track_embeddings WHERE track_id = $1`, `${P}trk`,
    );
    await prisma.$executeRawUnsafe(
        `INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out)
         SELECT track_id, analyzed_at, 1, 2, 3, 0.5, true FROM track_embeddings WHERE track_id = $1`, `${P}trk`,
    );
    await prisma.$executeRawUnsafe(
        `INSERT INTO matching_state (id, version, fingerprint, "trackCount", "feelMeanValence", "feelMeanArousal",
             "feelSdValence", "feelSdArousal", "soundSpread", "genreSpread", "genreWeight", genres)
         VALUES ('default', 'v', 'f', 1, 0.5, 0.5, 0.1, 0.1, 0.9, 0.5, 0.2, '{}'::jsonb)`,
    );
    for (const stage of ["recording", "analysis", "embedding"]) {
        await prisma.trackStage.create({
            data: { id: `${P}trk__${stage}`, trackId: `${P}trk`, stage, status: "done", attempt: 1, retryable: false },
        });
    }
    const genre = await prisma.genre.upsert({ where: { name: `${P}-genre` }, create: { name: `${P}-genre` }, update: {} });
    await prisma.trackGenre.create({ data: { trackId: `${P}trk`, genreId: genre.id } });
    await prisma.track.create({
        data: {
            id: `${P}gone`, albumId: `${P}alb`, title: "Gone Track", trackNo: 2, duration: 200,
            filePath: `/tmp/${P}-gone.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: "completed", vibeAnalysisStatus: "completed", missingSince: new Date(),
        },
    });
    for (const stage of ["analysis", "embedding"]) {
        await prisma.trackStage.create({
            data: { id: `${P}gone__${stage}`, trackId: `${P}gone`, stage, status: "done", attempt: 1, retryable: false },
        });
    }
    for (const entityType of ["track", "audio", "vibe", "artist"]) {
        await prisma.enrichmentFailure.create({ data: { entityType, entityId: `${P}-${entityType}` } });
    }
    await prisma.user.create({ data: { id: `${P}usr`, username: `${P}-user`, passwordHash: "x" } });
    await prisma.playlist.create({ data: { id: `${P}pl`, userId: `${P}usr`, name: "Mine" } });
    await prisma.playlistItem.create({ data: { playlistId: `${P}pl`, trackId: `${P}trk`, sort: 0 } });
    await prisma.play.create({ data: { userId: `${P}usr`, trackId: `${P}trk` } });
    await prisma.likedTrack.create({ data: { userId: `${P}usr`, trackId: `${P}trk` } });
    await prisma.track.create({
        data: {
            id: `${P}asking`, albumId: `${P}alb`, title: "Being Asked", trackNo: 3, duration: 200,
            filePath: `/tmp/${P}-asking.flac`, fileModified: new Date(), fileSize: 1000,
        },
    });
    await prisma.trackStage.create({
        data: {
            id: `${P}asking__recording`, trackId: `${P}asking`, stage: "recording", status: "working",
            attempt: 4, retryable: true, startedAt: new Date(), failures: 2,
            // What the attempt before this one failed with.
            lastErrorCode: "TIMEOUT", lastErrorMessage: "MusicBrainz did not answer", failureClass: "TRANSIENT",
        },
    });
    await prisma.track.create({
        data: {
            id: `${P}aside`, albumId: `${P}alb`, title: "Set Aside", trackNo: 4, duration: 200,
            filePath: `/tmp/${P}-aside.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: "failed", analysisError: "corrupt", vibeAnalysisStatus: "failed",
        },
    });
    for (const stage of ["analysis", "embedding"]) {
        await prisma.trackStage.create({
            data: {
                id: `${P}aside__${stage}`, trackId: `${P}aside`, stage, status: "blocked", attempt: 4, retryable: false,
                decidedAt: new Date(), decidedBy: "resolved-via-failures-api",
            },
        });
    }
    // A run that got this far before keeps its finished job for an hour; adding the same id again would be a no-op.
    await trackQueue.remove(`${P}asking-recording-4-r0`);
    await vibeQueue.remove(`${P}-vibe-1-r0`);
    await trackQueue.add("enrich", { trackId: `${P}asking` }, { jobId: `${P}asking-recording-4-r0` });
    await redisClient.rpush("audio:analysis:queue", JSON.stringify({ trackId: `${P}trk`, jobId: `${P}-1-r0` }));
    await vibeQueue.add("embed", { trackId: `${P}trk` }, { jobId: `${P}-vibe-1-r0` });

    await wipeEnrichment();
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await closeEngineConnections();
});

describe("wiping the enrichment", () => {
    it("drops the analysis and sound-vector jobs queued for the old questions", async () => {
        expect(await redisClient.llen("audio:analysis:queue")).toBe(0);
        expect(await vibeQueue.getJob(`${P}-vibe-1-r0`)).toBeUndefined();
    });

    it("reopens an identification claimed when the wipe came, along with dropping its queued job", async () => {
        expect(await trackQueue.getJob(`${P}asking-recording-4-r0`)).toBeUndefined();
        const stage = await prisma.trackStage.findUniqueOrThrow({ where: { id: `${P}asking__recording` } });
        expect(stage).toMatchObject({
            status: "pending", attempt: 4, startedAt: null,
            failures: 0, lastErrorCode: null, lastErrorMessage: null, failureClass: null,
        });
    });

    it("clears sound vectors, feel, the map and the library statistics", async () => {
        const counts = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT (SELECT count(*) FROM track_embeddings WHERE track_id = $1)::int
                  + (SELECT count(*) FROM matching_feel WHERE track_id = $1)::int
                  + (SELECT count(*) FROM matching_map WHERE track_id = $1)::int
                  + (SELECT count(*) FROM matching_state)::int AS n`,
            `${P}trk`,
        );
        expect(counts[0].n).toBe(0);
    });

    it("clears every track's analysis and sends it back through analysis and embedding", async () => {
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}trk` } });
        expect(t).toMatchObject({
            bpm: null, energy: null, valence: null, moodHappy: null, moodTags: [], essentiaGenres: [],
            analysisStatus: "pending", analysisVersion: null, analyzedAt: null, vibeAnalysisStatus: "pending",
        });
        const stages = await prisma.trackStage.findMany({ where: { trackId: `${P}trk` }, orderBy: { stage: "asc" } });
        expect(stages.map((s) => [s.stage, s.status, s.retryable])).toEqual([
            ["analysis", "pending", true],
            ["embedding", "pending", true],
            ["recording", "pending", true],
        ]);
    });

    it("leaves analysis and sound vectors a person set aside as they left them", async () => {
        const stages = await prisma.trackStage.findMany({ where: { trackId: `${P}aside` }, orderBy: { stage: "asc" } });
        expect(stages.map((s) => [s.stage, s.status, s.decidedBy])).toEqual([
            ["analysis", "blocked", "resolved-via-failures-api"],
            ["embedding", "blocked", "resolved-via-failures-api"],
        ]);
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}aside` } });
        expect(t).toMatchObject({ analysisStatus: "failed", analysisError: "corrupt", vibeAnalysisStatus: "failed" });
    });

    it("leaves a track whose file is gone closed as missing, so nothing waits on it", async () => {
        const stages = await prisma.trackStage.findMany({ where: { trackId: `${P}gone` }, orderBy: { stage: "asc" } });
        expect(stages.map((s) => [s.stage, s.status, s.failureClass, s.retryable])).toEqual([
            ["analysis", "failed", "FILE_MISSING", false],
            ["embedding", "failed", "FILE_MISSING", false],
        ]);
    });

    it("clears artist bios, genres and similar artists, and sends artists back through enrichment", async () => {
        const a = await prisma.artist.findUniqueOrThrow({ where: { id: `${P}art1` } });
        expect(a).toMatchObject({ summary: null, genres: null, similarArtistsJson: null, lastEnriched: null, enrichmentStatus: "pending" });
        expect(await prisma.similarArtist.count({ where: { fromArtistId: `${P}art1` } })).toBe(0);
    });

    it("clears the failures of the wiped steps, and only those", async () => {
        const left = await prisma.enrichmentFailure.findMany({ where: { entityId: { startsWith: P } } });
        expect(left.map((f) => f.entityType)).toEqual(["track"]);
    });

    it("asks identification again: the recording, its ISRC and its genres are cleared, the fingerprint kept", async () => {
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}trk` } });
        expect(t).toMatchObject({ recordingMbid: null, isrc: null, isrcSource: null, acoustidFingerprint: "AQAA" });
        expect(await prisma.trackGenre.count({ where: { trackId: `${P}trk` } })).toBe(0);
        const stage = await prisma.trackStage.findUniqueOrThrow({ where: { id: `${P}trk__recording` } });
        expect(stage.status).toBe("pending");
    });

    it("keeps the artist's id for the artist step to check, images, edits, playlists, plays and likes", async () => {
        const t = await prisma.track.findUniqueOrThrow({ where: { id: `${P}trk` } });
        expect(t).toMatchObject({ displayTitle: "My Title", hasUserOverrides: true });
        const a = await prisma.artist.findUniqueOrThrow({ where: { id: `${P}art1` } });
        expect(a).toMatchObject({ mbid: `${P}-mbid-1`, heroUrl: "/images/one.jpg", userSummary: "My own words", hasUserOverrides: true });
        expect(await prisma.album.count({ where: { id: `${P}alb`, rgMbid: `${P}-rg` } })).toBe(1);
        expect(await prisma.playlistItem.count({ where: { playlistId: `${P}pl` } })).toBe(1);
        expect(await prisma.play.count({ where: { userId: `${P}usr` } })).toBe(1);
        expect(await prisma.likedTrack.count({ where: { userId: `${P}usr` } })).toBe(1);
    });
});
