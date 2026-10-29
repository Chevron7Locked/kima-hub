/**
 * Song mood tags, written by the mood step after the scores and statistics (state.ts). A song is tagged with each live
 * mood it sits at least TAG_LINE_Z standard deviations above the library's mean in, so tags are relative to the library
 * and move with it. A mood with a definition (mixes/moodDefinitions.json) is tagged by its defined score, standardised
 * over the library songs that have one, the same score the recipes read, so a tag and a recipe cannot disagree about
 * what the mood means. A retired mood (night) has no tag. Every copy of a title is tagged: a tag describes the song,
 * and an untagged second copy of a tagged song would play on the Wildcard station.
 */
import { Prisma } from "@prisma/client";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { BUILD_TIMEOUT_MS, isWriteConflict } from "../matching/state";
import {
    MIN_MIX_TRACKS,
    RECIPE_LINE,
    SCORED_SONGS,
    UnrankableLibraryError,
    definedCtes,
    definedStatsCte,
    definedZSql,
    definitionInputs,
} from "../mixes/recipes";
import { DEFINITIONS, type MoodDefinition } from "../mixes/moodDefinitions";
import { LIVE_MOODS, MOOD_HEADS } from "./heads";
import { moodStateOf } from "./state";

/** A song is tagged at this many library SDs above the mean of its mood's score: the recipes' own line. */
export const TAG_LINE_Z = RECIPE_LINE;

/**
 * The statistics row (version, inputs fingerprint, written at) the last complete tag pass in this process read. The
 * row is rewritten whenever its inputs fingerprint (state.ts) changes, so a pass over the same row would change
 * nothing; that holds only while no definition reads outside the fingerprint, which tags.test.ts checks.
 */
let taggedFrom: string | null = null;

/** The statistics row's signature, as taggedFrom holds it: none while there is no row. */
const SIGNATURE = Prisma.sql`
    SELECT version || ':' || fingerprint || ':' || computed_at::text AS signature
    FROM mood_state WHERE id = 'default'
`;

/**
 * Every track's mood tags, in the moods' order. A defined mood is tagged when the song's defined score, standardised
 * over the library songs that have one, reaches the line: a song missing a reading the definition reads has no tag of
 * that mood, a definition the library cannot score (a reading no song has, or one with no spread) tags no song, and
 * no song is tagged a defined mood while the library holds fewer than MIN_MIX_TRACKS songs. Tags are
 * relative to the library, so they are set from the current scores and statistics; a track the statistics leave out
 * has none, and only tracks whose tags differ are written. A pass over the statistics the last one wrote from is
 * skipped: a song going missing or corrupt, finishing or restarting analysis, or a re-run clearing tags changes them.
 * Without statistics for these weights (a rescore or a re-run cleared them, or no track is eligible) nothing is written
 * and every track keeps its tags until a pass has statistics again. Returns how many tracks' tags changed.
 */
export async function writeMoodTags(): Promise<number> {
    const [current] = await prisma.$queryRaw<Array<{ signature: string }>>(SIGNATURE);
    if (current && current.signature === taggedFrom) return 0;
    try {
        // Read committed, so a track another writer changes meanwhile is waited for instead of failing the pass.
        const { written, signature } = await prisma.$transaction(
            async (tx) => {
                // The state row first, as the build and a re-run take it, before the track rows: one order, so neither
                // deadlocks. Held to the commit, so the statistics cannot change under the update.
                await tx.$queryRaw`SELECT id FROM mood_state WHERE id = 'default' FOR UPDATE`;
                const state = moodStateOf(await tx.moodState.findUnique({ where: { id: "default" } }));
                if (!state) return { written: 0, signature: null };
                const scorable: MoodDefinition[] = [];
                if (state.trackCount >= MIN_MIX_TRACKS) {
                    for (const definition of DEFINITIONS.values()) {
                        try {
                            definedCtes("tags", state, [definition], "library");
                            scorable.push(definition);
                        } catch (error) {
                            if (!(error instanceof UnrankableLibraryError)) throw error;
                        }
                    }
                }
                const defined = scorable.length > 0
                    ? Prisma.sql`WITH library AS (
                            SELECT t.id, ${definitionInputs(scorable)} ${SCORED_SONGS}
                        ),
                        ${definedCtes("tags", state, scorable, "library")},
                        ${definedStatsCte(scorable)}`
                    : Prisma.empty;
                const isScorable = (mood: string) => scorable.some((d) => d.mood === mood);
                const tags = Prisma.raw(
                    `array_remove(ARRAY[${LIVE_MOODS.map((mood) =>
                        DEFINITIONS.has(mood)
                            ? isScorable(mood)
                                ? `CASE WHEN d.dscore_${mood} IS NOT NULL AND ${definedZSql(mood, "d")} >= ${TAG_LINE_Z}
                                   THEN '${mood}' END`
                                : "NULL"
                            : `CASE WHEN (m."${mood}" - s."${mood}_mean") / NULLIF(s."${mood}_sd", 0) >= ${TAG_LINE_Z}
                               THEN '${mood}' END`,
                    ).join(", ")}]::text[], NULL)`,
                );
                const changed = await tx.$executeRaw`
                    ${defined}
                    UPDATE "Track" t
                    SET "moodTags" = n.tags
                    FROM (
                        SELECT tr.id,
                               CASE WHEN te.track_id IS NOT NULL
                                         AND tr."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = tr."albumId" AND la.location = 'LIBRARY') AND tr.corrupt = false
                                         AND tr."analysisStatus" = 'completed'
                                    THEN ${tags} ELSE '{}'::text[] END AS tags
                        FROM "Track" tr
                        JOIN mood_state s ON s.id = 'default'
                        LEFT JOIN track_moods m ON m.track_id = tr.id AND m.weights = ${MOOD_HEADS.version}
                        LEFT JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
                                                     AND te.model_version = ${MOOD_HEADS.model}
                        ${scorable.length > 0 ? Prisma.sql`LEFT JOIN defined d ON d.id = tr.id CROSS JOIN def_stats ds` : Prisma.empty}
                    ) n
                    WHERE t.id = n.id AND t."moodTags" IS DISTINCT FROM n.tags
                `;
                const [{ signature }] = await tx.$queryRaw<Array<{ signature: string }>>(SIGNATURE);
                return { written: changed, signature };
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
                timeout: BUILD_TIMEOUT_MS,
                maxWait: BUILD_TIMEOUT_MS,
            },
        );
        if (signature) taggedFrom = signature;
        return written;
    } catch (error) {
        // Another transaction held tracks this one needed (a deadlock): nothing was written, and the next pass
        // rewrites the tags from the data as it is then.
        if (isWriteConflict(error)) {
            logger.info("[Moods] Tracks changed while the tags were written; the next pass writes them");
            return 0;
        }
        throw error;
    }
}
