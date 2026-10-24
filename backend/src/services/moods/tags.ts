/**
 * Song mood tags, written by the mood step after the scores and statistics (state.ts). A song is tagged with each
 * learned mood it sits at least TAG_LINE_Z standard deviations above the library's mean in, so tags are relative to the
 * library and move with it. Focus is the one mood tagged by its mix instead of its own score: a song is tagged focus
 * when it is a member of the Focus Mix at the line. The focus score alone also rates vocal workout songs high, and the
 * Focus Mix weighs in how instrumental a song is and leaves out the library's loudest quarter.
 */
import { Prisma } from "@prisma/client";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { BUILD_TIMEOUT_MS, isWriteConflict } from "../matching/state";
import { UnrankableLibraryError, getRecipe, recipeRankingSql } from "../mixes/recipes";
import { MOODS, MOOD_HEADS } from "./heads";
import { moodStateOf } from "./state";

/** A song is tagged at this many library SDs above the mean of its mood's score; for focus, of the recipe score. */
export const TAG_LINE_Z = 1.25;

/** The recipe whose members, at the line and through its filters, are tagged focus. */
const FOCUS_RECIPE = "focus";

/**
 * Every track's mood tags, in the moods' order. Focus is tagged when the song's Focus Mix recipe score, standardised
 * over the songs that recipe ranks, reaches the line and the song passes the recipe's filters, as the engine picks the
 * Focus Mix's members; a song the recipe cannot rank (no instrumental reading) has no focus tag, and neither has any
 * song when the library cannot be ranked for it. Tags are relative to the library, so every pass sets them from the
 * current scores and statistics; a track the statistics leave out has none. Only tracks whose tags differ are written,
 * so a pass also refills tags that anything else cleared. Without statistics for these weights (a rescore or a re-run
 * cleared them, or no track is eligible) nothing is written and every track keeps its tags until a pass has statistics
 * again. Returns how many tracks' tags changed.
 */
export async function writeMoodTags(): Promise<number> {
    try {
        // Read committed, so a track another writer changes meanwhile is waited for instead of failing the pass.
        return await prisma.$transaction(
            async (tx) => {
                // The state row first, as the build and a re-run take it, before the track rows: one order, so neither
                // deadlocks. Held to the commit, so the statistics cannot change under the update.
                await tx.$queryRaw`SELECT id FROM mood_state WHERE id = 'default' FOR UPDATE`;
                const state = moodStateOf(await tx.moodState.findUnique({ where: { id: "default" } }));
                if (!state) return 0;
                let focus: Prisma.Sql | null = null;
                try {
                    focus = recipeRankingSql(getRecipe(FOCUS_RECIPE), state);
                } catch (error) {
                    if (!(error instanceof UnrankableLibraryError)) throw error;
                }
                const tags = Prisma.raw(
                    `array_remove(ARRAY[${MOODS.map((mood) =>
                        mood === "focus"
                            ? focus ? `CASE WHEN f.recipe_z >= ${TAG_LINE_Z} AND f.in_filters THEN 'focus' END` : "NULL"
                            : `CASE WHEN (m."${mood}" - s."${mood}_mean") / NULLIF(s."${mood}_sd", 0) >= ${TAG_LINE_Z}
                               THEN '${mood}' END`,
                    ).join(", ")}]::text[], NULL)`,
                );
                return tx.$executeRaw`
                    ${focus ? Prisma.sql`WITH ${focus}` : Prisma.empty}
                    UPDATE "Track" t
                    SET "moodTags" = n.tags
                    FROM (
                        SELECT tr.id,
                               CASE WHEN te.track_id IS NOT NULL
                                         AND tr."missingSince" IS NULL AND tr.corrupt = false
                                         AND tr."analysisStatus" = 'completed'
                                    THEN ${tags} ELSE '{}'::text[] END AS tags
                        FROM "Track" tr
                        JOIN mood_state s ON s.id = 'default'
                        LEFT JOIN track_moods m ON m.track_id = tr.id AND m.weights = ${MOOD_HEADS.version}
                        LEFT JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
                                                     AND te.model_version = ${MOOD_HEADS.model}
                        ${focus ? Prisma.sql`LEFT JOIN placed f ON f.id = tr.id` : Prisma.empty}
                    ) n
                    WHERE t.id = n.id AND t."moodTags" IS DISTINCT FROM n.tags
                `;
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
                timeout: BUILD_TIMEOUT_MS,
                maxWait: BUILD_TIMEOUT_MS,
            },
        );
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
