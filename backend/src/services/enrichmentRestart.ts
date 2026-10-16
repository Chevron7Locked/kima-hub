/**
 * Re-run the enrichment from any of its five steps: identification (which
 * recording each track is), artists, audio analysis, sound vectors, or the
 * similarity step (feel, statistics and the vibe map). A re-run redoes its
 * step and everything that depends on it; nothing the engine worked out is
 * frozen across a run, and the vibe map is laid out again. Answers a person
 * set aside or closed stay as they left them, and everything people made --
 * the library, playlists, plays, likes, edits and artist images -- stays.
 */
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { trackQueue, vibeQueue } from "../workers/enrichmentQueues";
import { STAGE_QUEUES } from "../workers/unifiedEnrichment";
import { closeStagesForMissingTracks } from "./missingFileStages";
import { askedAgain } from "./stageReopen";
import { RERUN_TIMEOUT_MS } from "./matching/state";

export type RerunStep = "identification" | "artists" | "analysis" | "vectors" | "similarity";

export interface EnrichmentWipe {
    artists: number;
    tracks: number;
    vectors: number;
}

/**
 * What each step's re-run clears, in the order the resets share a transaction.
 * Every step also clears the similarity state and the map, because the
 * formula reads artist genres, analysis and sound vectors.
 */
const STEP_CLEARS: Record<RerunStep, {
    recording: boolean;
    artists: boolean;
    analysis: boolean;
    vectors: boolean;
}> = {
    identification: { recording: true, artists: true, analysis: true, vectors: true },
    artists: { recording: false, artists: true, analysis: false, vectors: false },
    analysis: { recording: false, artists: false, analysis: true, vectors: true },
    vectors: { recording: false, artists: false, analysis: false, vectors: true },
    similarity: { recording: false, artists: false, analysis: false, vectors: false },
};

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function resetArtists(tx: Tx): Promise<number> {
    await tx.$executeRaw`DELETE FROM "SimilarArtist"`;
    return tx.$executeRaw`
        UPDATE "Artist"
        SET summary = NULL, genres = NULL, "similarArtistsJson" = NULL,
            "lastEnriched" = NULL, "enrichmentStatus" = 'pending', "enrichmentFailures" = 0
    `;
}

function resetRecording(tx: Tx): Promise<unknown> {
    // Identification is asked again where it was answered or is being asked; a
    // question closed for good or decided by a person stays as it is.
    return tx.$executeRaw`
        WITH reopened AS (
            UPDATE "TrackStage"
            SET ${askedAgain}, evidence = jsonb_build_object('reason', 'enrichment wiped')
            WHERE stage = 'recording' AND status IN ('done', 'working') AND "decidedAt" IS NULL
            RETURNING "trackId"
        ), cleared AS (
            DELETE FROM "TrackGenre" WHERE "trackId" IN (SELECT "trackId" FROM reopened) RETURNING 1
        )
        UPDATE "Track" t
        SET "recordingMbid" = NULL,
            isrc = CASE WHEN t."isrcSource" = 'musicbrainz' THEN NULL ELSE t.isrc END,
            "isrcSource" = CASE WHEN t."isrcSource" = 'musicbrainz' THEN NULL ELSE t."isrcSource" END
        FROM reopened r WHERE t.id = r."trackId"
    `;
}

async function resetAnalysis(tx: Tx): Promise<number> {
    const tracks = await tx.$executeRaw`
        UPDATE "Track"
        SET bpm = NULL, "beatsCount" = NULL, key = NULL, "keyScale" = NULL, "keyStrength" = NULL,
            energy = NULL, loudness = NULL, "dynamicRange" = NULL, danceability = NULL,
            valence = NULL, arousal = NULL, "deamValence" = NULL, "deamArousal" = NULL,
            "clapValenceRaw" = NULL, "clapArousalRaw" = NULL,
            instrumentalness = NULL, acousticness = NULL, speechiness = NULL,
            "moodHappy" = NULL, "moodSad" = NULL, "moodRelaxed" = NULL, "moodAggressive" = NULL,
            "moodParty" = NULL, "moodAcoustic" = NULL, "moodElectronic" = NULL, "danceabilityMl" = NULL,
            "moodTags" = '{}', "essentiaGenres" = '{}',
            "analysisStatus" = 'pending', "analysisVersion" = NULL, "analysisMode" = NULL,
            "analyzedAt" = NULL, "analysisError" = NULL, "analysisRetryCount" = 0, "analysisStartedAt" = NULL
        WHERE NOT EXISTS (SELECT 1 FROM "TrackStage" s
                          WHERE s."trackId" = "Track".id AND s.stage = 'analysis' AND s."decidedAt" IS NOT NULL)
    `;
    await tx.$executeRaw`
        UPDATE "TrackStage"
        SET ${askedAgain}, evidence = NULL
        WHERE stage = 'analysis' AND "decidedAt" IS NULL
    `;
    return tracks;
}

async function resetVectors(tx: Tx): Promise<number> {
    const vectors = await tx.$executeRaw`
        DELETE FROM track_embeddings e
        WHERE NOT EXISTS (SELECT 1 FROM "TrackStage" s
                          WHERE s."trackId" = e.track_id AND s.stage = 'embedding' AND s."decidedAt" IS NOT NULL)
    `;
    await tx.$executeRaw`
        UPDATE "Track"
        SET "vibeAnalysisStatus" = 'pending', "vibeAnalysisStartedAt" = NULL, "vibeAnalysisError" = NULL,
            "vibeAnalysisRetryCount" = 0, "vibeAnalysisStatusUpdatedAt" = NULL
        WHERE NOT EXISTS (SELECT 1 FROM "TrackStage" s
                          WHERE s."trackId" = "Track".id AND s.stage = 'embedding' AND s."decidedAt" IS NOT NULL)
    `;
    await tx.$executeRaw`
        UPDATE "TrackStage"
        SET ${askedAgain}, evidence = NULL
        WHERE stage = 'embedding' AND "decidedAt" IS NULL
    `;
    return vectors;
}

/**
 * The first statement of every re-run. A map write locks the state row before it touches the stored map
 * (matching/map.ts), so the re-run takes that row before anything that reaches the map: deleting sound vectors
 * removes their map rows with them. Both sides then lock state first and map second, and never deadlock; a layout
 * in flight either finishes before the re-run clears it or finds no state and writes nothing.
 */
function releaseMatchingState(tx: Tx): Promise<unknown> {
    return tx.$executeRaw`DELETE FROM matching_state`;
}

/**
 * The stage rows a re-run resets, locked right after the state and before any track or vector row. Both analyzers
 * lock a track's stage row before they write its track or vector, so taking the stage rows first keeps one order and
 * no deadlock: an analyzer holding one finishes first, and its claim is then refused when it next reports.
 */
function lockStages(tx: Tx, stages: string[]): Promise<unknown> {
    return tx.$queryRaw`
        SELECT count(*) FROM (SELECT 1 FROM "TrackStage" WHERE stage = ANY(${stages}) AND "decidedAt" IS NULL FOR UPDATE) locked
    `;
}

function resetSimilarity(tx: Tx): Promise<unknown> {
    // With the state gone (above), deleting every stored position makes the next similarity pass lay the map out
    // again from scratch.
    return tx.$executeRaw`DELETE FROM matching_map`;
}

export async function rerunEnrichment(from: RerunStep): Promise<EnrichmentWipe> {
    const clears = STEP_CLEARS[from];
    const trackWork = clears.recording || clears.analysis || clears.vectors;
    // Queued jobs go first, then every open record is reset, the claimed ones too. A job claimed
    // before the reset holds a claim that no longer matches and is refused when it reports; one
    // claimed after it is a real claim. Emptying the queues after the reset would drop real jobs
    // and leave their records claimed until the lease ran out.
    if (trackWork) {
        await redisClient.del(STAGE_QUEUES.analysis);
        await vibeQueue.drain();
        await trackQueue.drain();
    }
    return prisma.$transaction(
        async (tx) => {
            await releaseMatchingState(tx);
            const stages = [clears.recording && "recording", clears.analysis && "analysis", clears.vectors && "embedding"];
            const reset = stages.filter((s): s is string => Boolean(s));
            if (reset.length > 0) await lockStages(tx, reset);
            // A step a person set aside for a track stays as they left it.
            let artists = 0;
            let tracks = 0;
            let vectors = 0;
            if (clears.recording) await resetRecording(tx);
            if (clears.artists) artists = await resetArtists(tx);
            if (clears.analysis) tracks = await resetAnalysis(tx);
            if (clears.vectors) vectors = await resetVectors(tx);
            if (clears.artists) {
                await tx.$executeRaw`DELETE FROM "EnrichmentFailure" WHERE "entityType" = 'artist'`;
            }
            // Stage failures live in TrackStage and reset with their stage; the
            // table's audio/vibe rows only cover system errors on those steps.
            if (clears.analysis) {
                await tx.$executeRaw`DELETE FROM "EnrichmentFailure" WHERE "entityType" = 'audio'`;
            }
            if (clears.vectors) {
                await tx.$executeRaw`DELETE FROM "EnrichmentFailure" WHERE "entityType" = 'vibe'`;
            }
            await resetSimilarity(tx);
            // A file that is gone cannot be re-run; its records wait for a scan to find it.
            if (trackWork) await closeStagesForMissingTracks(tx);
            return { artists, tracks, vectors };
        },
        { timeout: RERUN_TIMEOUT_MS, maxWait: RERUN_TIMEOUT_MS },
    );
}

/** The original full wipe: the identification step and everything after it. */
export async function wipeEnrichment(): Promise<EnrichmentWipe> {
    return rerunEnrichment("identification");
}
