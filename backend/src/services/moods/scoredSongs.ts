/**
 * Which songs the mood statistics cover, written once. The statistics, their inputs fingerprint, the mood tags, the
 * recipes' song set and the mood buckets all read the same songs; a copy of the rule that drifts from the others makes
 * a tag, a statistic and a mix disagree about which songs exist.
 */
import { Prisma } from "@prisma/client";
import { MOOD_HEADS } from "./heads";

/**
 * SQL true for the track under `alias` when it can be covered, whatever its scores: the file is present, the album is a
 * library album (Discover songs are never scored for the moods), no scan marked it corrupt, and its analysis finished.
 */
export function coveredTrackSql(alias: string): Prisma.Sql {
    const t = Prisma.raw(alias);
    return Prisma.sql`${t}."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = ${t}."albumId" AND la.location = 'LIBRARY') AND ${t}.corrupt = false AND ${t}."analysisStatus" = 'completed'`;
}

/**
 * The condition for a query over `track_moods m JOIN track_embeddings te ... JOIN "Track" t`: the scores are current for
 * the weights and the sound vector's model, and the track is covered (coveredTrackSql).
 */
export const SCORED_SONGS_RULE = Prisma.sql`m.weights = ${MOOD_HEADS.version} AND te.model_version = ${MOOD_HEADS.model}
      AND ${coveredTrackSql("t")}`;
