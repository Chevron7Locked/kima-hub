/**
 * Song mood tags, written by the mood step after the scores and statistics (state.ts). A song is tagged with each
 * learned mood it sits at least TAG_LINE_Z standard deviations above the library's mean in, so tags are relative to the
 * library and move with it. Focus is the one mood tagged by its mix instead of its own score: a song is tagged focus
 * when it sits at the Focus Mix's line by the mix's own rules. The focus score alone also rates vocal workout songs
 * high; the Focus Mix weighs in how instrumental a song is and leaves out the loudest quarter of the songs it ranks.
 * Every copy of a title is tagged, where the mix plays one: a tag describes the song, and an untagged second copy of a
 * Focus Mix song would play on the Wildcard station.
 */
import { Prisma } from "@prisma/client";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { BUILD_TIMEOUT_MS, isWriteConflict } from "../matching/state";
import {
    MIN_MIX_TRACKS,
    RECIPE_LINE,
    UnrankableLibraryError,
    atLineSql,
    getRecipe,
    recipeRankingSql,
} from "../mixes/recipes";
import { MOODS, MOOD_HEADS } from "./heads";
import { moodStateOf } from "./state";

/**
 * A song is tagged at this many library SDs above the mean of its mood's score: the recipes' own line, so a mood tag
 * and the focus tag, which is the Focus Mix's line, cannot drift apart.
 */
export const TAG_LINE_Z = RECIPE_LINE;

/** The recipe whose songs at the line are tagged focus. */
export const FOCUS_RECIPE = "focus";

/**
 * The statistics row (version, inputs fingerprint and when it was written) the last complete pass in this process wrote
 * every track's tags from. Tags read the scores, which songs are eligible (a present, readable file with finished
 * analysis and current scores) and, for focus, what the Focus Mix recipe reads. The inputs fingerprint (state.ts)
 * covers the scores, the eligible songs and the arousal, instrumental and acoustic readings, but not tempo, its
 * confidence or the key's scale. The skip is safe only because the focus recipe reads nothing outside the fingerprint;
 * tags.test.ts fails if it starts to. The row is rewritten whenever the fingerprint changes, so a pass over the same
 * row would change nothing.
 */
let taggedFrom: string | null = null;

/** The statistics row's signature, as taggedFrom holds it: none while there is no row. */
const SIGNATURE = Prisma.sql`
    SELECT version || ':' || fingerprint || ':' || computed_at::text AS signature
    FROM mood_state WHERE id = 'default'
`;

/**
 * Every track's mood tags, in the moods' order. Focus is tagged when the song's Focus Mix recipe score, standardised
 * over the songs that recipe ranks, reaches the line and the song passes the recipe's filters, by the rules the engine
 * picks the Focus Mix's members with: a song the recipe cannot rank (no instrumental reading) has no focus tag, and
 * neither has any song while the library or the recipe's ranking holds fewer than MIN_MIX_TRACKS songs. Tags are
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
                let focus: Prisma.Sql | null = null;
                try {
                    if (state.trackCount >= MIN_MIX_TRACKS) focus = recipeRankingSql(getRecipe(FOCUS_RECIPE), state);
                } catch (error) {
                    if (!(error instanceof UnrankableLibraryError)) throw error;
                }
                const tags = Prisma.raw(
                    `array_remove(ARRAY[${MOODS.map((mood) =>
                        mood === "focus"
                            ? focus ? `CASE WHEN ${atLineSql("f")} THEN 'focus' END` : "NULL"
                            : `CASE WHEN (m."${mood}" - s."${mood}_mean") / NULLIF(s."${mood}_sd", 0) >= ${TAG_LINE_Z}
                               THEN '${mood}' END`,
                    ).join(", ")}]::text[], NULL)`,
                );
                const changed = await tx.$executeRaw`
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
