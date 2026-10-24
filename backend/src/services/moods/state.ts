/**
 * The mood enrichment step.
 * Per track it stores the 22 learned mood scores for the sound vector they were computed from; per library it
 * stores the mean and spread of each mood and of each reading the mixes blend with them, rebuilt whenever the
 * eligible tracks, their sound vectors, their readings or the weights change. The song tags are written from both
 * (tags.ts).
 */
import crypto from "crypto";
import { Prisma, type MoodState as MoodStateRow } from "@prisma/client";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { formatEmbedding } from "../../utils/embedding";
import { BUILD_TIMEOUT_MS, isWriteConflict } from "../matching/state";
import { MOODS, MOOD_HEADS, type Mood } from "./heads";

/** Raise when the tracks the statistics cover or a reading's transform changes, so every library rebuilds them. */
const STATE_FORMULA_VERSION = 2;
export const MOOD_STATE_VERSION = `${STATE_FORMULA_VERSION}/${MOOD_HEADS.version}`;

/**
 * The readings the mixes blend with the moods: the stored arousal and CLAP's instrumental and acoustic probabilities,
 * each as a logit, clipped to 0.01-0.99 first so a value of 0 or 1 stays finite.
 */
export const READINGS = ["arousal", "instrumental_logit", "acoustic_logit"] as const;
export type Reading = (typeof READINGS)[number];

// GREATEST and LEAST skip a NULL argument, so a missing reading is kept NULL explicitly rather than read as 0.01.
const logit = (column: string) => {
    const p = `LEAST(0.99, GREATEST(0.01, t.${column}))`;
    return `CASE WHEN t.${column} IS NOT NULL THEN ln(${p} / (1 - ${p})) END`;
};
export const READING_SQL: Record<Reading, string> = {
    arousal: logit("arousal"),
    instrumental_logit: logit("instrumentalness"),
    acoustic_logit: logit("acousticness"),
};

const quoted = (names: readonly string[]) => Prisma.raw(names.map((name) => `"${name}"`).join(", "));

/** Scores for every sound vector of the heads' model that has none, older ones, or ones from other weights. */
export async function updateMoods(tx: Prisma.TransactionClient): Promise<number> {
    // The heads were fitted on unit-length vectors, and the writer lets a stored one's length differ from 1 slightly.
    const scores = Prisma.join(
        MOODS.map((mood) => {
            const { weights, bias } = MOOD_HEADS.heads[mood];
            const w = formatEmbedding(weights);
            return Prisma.sql`-(te.embedding <#> ${w}::vector) / vector_norm(te.embedding) + ${bias}::float8`;
        }),
    );
    const updates = Prisma.raw(MOODS.map((mood) => `"${mood}" = EXCLUDED."${mood}"`).join(", "));
    return tx.$executeRaw`
        WITH stale AS MATERIALIZED (
            SELECT te.track_id
            FROM track_embeddings te
            LEFT JOIN track_moods m ON m.track_id = te.track_id
            WHERE te.model_version = ${MOOD_HEADS.model}
              AND (m.track_id IS NULL
                   OR m.embedded_at IS DISTINCT FROM te.analyzed_at
                   OR m.weights IS DISTINCT FROM ${MOOD_HEADS.version})
        )
        INSERT INTO track_moods (track_id, embedded_at, weights, ${quoted(MOODS)})
        SELECT te.track_id, te.analyzed_at, ${MOOD_HEADS.version}, ${scores}
        FROM stale s
        JOIN track_embeddings te ON te.track_id = s.track_id
        WHERE vector_dims(te.embedding) = ${MOOD_HEADS.dims} AND vector_norm(te.embedding) > 0
        ON CONFLICT (track_id) DO UPDATE
        SET embedded_at = EXCLUDED.embedded_at, weights = EXCLUDED.weights, ${updates}
    `;
}

/**
 * Changes whenever an eligible track, its sound vector or one of its readings changes. The eligible tracks are the
 * ones the statistics cover: current scores, a file that is there and readable, and finished analysis.
 */
async function inputsFingerprint(tx: Prisma.TransactionClient): Promise<string> {
    const [row] = await tx.$queryRaw<Array<{ n: number; h: string }>>`
        SELECT count(*)::int AS n,
               COALESCE(sum(hashtextextended(
                   m.track_id || ':' || extract(epoch FROM m.embedded_at)::text || ':' ||
                   COALESCE(t.arousal::text, '') || ':' || COALESCE(t.instrumentalness::text, '') || ':' ||
                   COALESCE(t.acousticness::text, ''), 0)), 0)::text AS h
        FROM track_moods m
        JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
        JOIN "Track" t ON t.id = m.track_id
        WHERE m.weights = ${MOOD_HEADS.version} AND te.model_version = ${MOOD_HEADS.model}
          AND t."missingSince" IS NULL AND t.corrupt = false AND t."analysisStatus" = 'completed'
    `;
    return crypto.createHash("sha256").update(JSON.stringify([MOOD_STATE_VERSION, row.n, row.h])).digest("hex");
}

type StatColumn = `${Mood | Reading}_${"mean" | "sd"}`;

type StateColumns = Omit<Prisma.MoodStateCreateInput, "id" | "version" | "fingerprint" | "computed_at">;

/**
 * Each mood's and reading's mean and population SD over the eligible tracks, or null when none is eligible. A reading
 * a track lacks leaves that track out of that reading's statistics only; a reading no eligible track has is stored as
 * absent, so the moods keep their statistics and only the recipes that blend that reading refuse.
 */
async function computeState(tx: Prisma.TransactionClient): Promise<StateColumns | null> {
    const aggregates = Prisma.raw(
        [...MOODS.map((mood) => [mood, `m."${mood}"`] as const), ...READINGS.map((r) => [r, READING_SQL[r]] as const)]
            .map(([name, value]) => [
                `avg(${value} ORDER BY m.track_id) AS "${name}_mean"`,
                `stddev_pop(${value} ORDER BY m.track_id) AS "${name}_sd"`,
            ].join(", "))
            .join(",\n"),
    );
    const [row] = await tx.$queryRaw<Array<{ n: number } & Record<StatColumn, number | null>>>`
        SELECT count(*)::int AS n, ${aggregates}
        FROM track_moods m
        JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
        JOIN "Track" t ON t.id = m.track_id
        WHERE m.weights = ${MOOD_HEADS.version} AND te.model_version = ${MOOD_HEADS.model}
          AND t."missingSince" IS NULL AND t.corrupt = false AND t."analysisStatus" = 'completed'
    `;
    if (row.n === 0) return null;
    const finite = (column: StatColumn): number => {
        const value = row[column];
        if (value === null || !Number.isFinite(value)) {
            throw new Error(`[Moods] ${column} has no value over ${row.n} eligible tracks`);
        }
        return value;
    };
    const stats = {} as Record<`${Mood}_${"mean" | "sd"}`, number> &
        Record<`${Reading}_${"mean" | "sd"}`, number | null>;
    for (const mood of MOODS) {
        stats[`${mood}_mean`] = finite(`${mood}_mean`);
        stats[`${mood}_sd`] = finite(`${mood}_sd`);
    }
    for (const reading of READINGS) {
        if (row[`${reading}_mean`] === null) {
            logger.warn(`[Moods] No eligible track has the ${reading} reading; recipes that blend it rank no songs`);
            stats[`${reading}_mean`] = null;
            stats[`${reading}_sd`] = null;
            continue;
        }
        stats[`${reading}_mean`] = finite(`${reading}_mean`);
        stats[`${reading}_sd`] = finite(`${reading}_sd`);
    }
    return { track_count: row.n, ...stats };
}

/** The statistics, rebuilt when their inputs changed; true when the stored row was written or removed. */
export async function buildMoodState(tx: Prisma.TransactionClient): Promise<boolean> {
    const fingerprint = await inputsFingerprint(tx);
    const current = await tx.moodState.findUnique({
        where: { id: "default" },
        select: { version: true, fingerprint: true },
    });
    if (current?.version === MOOD_STATE_VERSION && current.fingerprint === fingerprint) return false;
    const state = await computeState(tx);
    if (!state) {
        const { count } = await tx.moodState.deleteMany({});
        return count > 0;
    }
    const columns = { version: MOOD_STATE_VERSION, fingerprint, ...state, computed_at: new Date() };
    await tx.moodState.upsert({ where: { id: "default" }, create: { id: "default", ...columns }, update: columns });
    return true;
}

/**
 * One run of the step: scores for new or changed sound vectors, then the statistics when their inputs changed. One
 * transaction, so a mix never reads scores from one set of weights with statistics from another. After a large batch
 * of scores, the planner's counts for them are refreshed.
 */
export async function buildMoods(): Promise<{ scored: number; stateChanged: boolean }> {
    let built: { scored: number; stateChanged: boolean };
    try {
        built = await prisma.$transaction(
            async (tx) => {
                // The state row first, as a re-run takes it, before the score rows: one order, so neither deadlocks.
                await tx.$queryRaw`SELECT id FROM mood_state WHERE id = 'default' FOR UPDATE`;
                const scored = await updateMoods(tx);
                const stateChanged = await buildMoodState(tx);
                return { scored, stateChanged };
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
                timeout: BUILD_TIMEOUT_MS,
                maxWait: BUILD_TIMEOUT_MS,
            },
        );
    } catch (error) {
        // A re-run changed the scores or the state while this build waited: what it read is out of date, so nothing is
        // written and the next pass builds from the new data.
        if (isWriteConflict(error)) {
            logger.info("[Moods] Scores changed while the build waited; the next pass rebuilds them");
            return { scored: 0, stateChanged: false };
        }
        throw error;
    }
    if (built.scored > 0) await refreshPlannerCounts(built.scored);
    return built;
}

/** A batch of more scores than this, or than ANALYZE_SHARE of the rows the planner last counted, is a large one. */
const ANALYZE_ROWS = 1000;
const ANALYZE_SHARE = 0.1;

/**
 * The planner's row counts for the scores, refreshed after a large batch instead of whenever autovacuum next gets to
 * the table: until then a library scored for the first time still counts as empty, and the tag, mix, station and
 * mood-page queries are planned for an empty table. Run after the batch commits; a failure only leaves the counts to
 * autovacuum.
 */
async function refreshPlannerCounts(scored: number): Promise<void> {
    try {
        // reltuples is -1 for a table never analysed.
        const [{ counted }] = await prisma.$queryRaw<Array<{ counted: number }>>`
            SELECT greatest(reltuples, 0)::float8 AS counted FROM pg_class WHERE oid = 'track_moods'::regclass
        `;
        if (scored > ANALYZE_ROWS || scored > ANALYZE_SHARE * counted) {
            await prisma.$executeRaw`ANALYZE track_moods`;
        }
    } catch (error) {
        logger.warn("[Moods] Could not refresh the planner's counts for the scores; autovacuum will:", error);
    }
}

export interface MoodStats {
    mean: number;
    sd: number;
}

export interface MoodState {
    trackCount: number;
    moods: Record<Mood, MoodStats>;
    /** Null for a reading no eligible track has. */
    readings: Record<Reading, MoodStats | null>;
}

/** The library's statistics, or null until the mood step has built them for these weights. */
export async function loadMoodState(): Promise<MoodState | null> {
    return moodStateOf(await prisma.moodState.findUnique({ where: { id: "default" } }));
}

/** The statistics a stored row holds, or null for no row or a row of other weights. */
export function moodStateOf(row: MoodStateRow | null): MoodState | null {
    if (!row || row.version !== MOOD_STATE_VERSION) return null;
    const moodStats = (name: Mood): MoodStats => ({ mean: row[`${name}_mean`], sd: row[`${name}_sd`] });
    const readingStats = (name: Reading): MoodStats | null => {
        const mean = row[`${name}_mean`];
        const sd = row[`${name}_sd`];
        return mean === null || sd === null ? null : { mean, sd };
    };
    return {
        trackCount: row.track_count,
        moods: Object.fromEntries(MOODS.map((name) => [name, moodStats(name)])) as Record<Mood, MoodStats>,
        readings: Object.fromEntries(READINGS.map((name) => [name, readingStats(name)])) as MoodState["readings"],
    };
}

/** Tracks with a scoreable sound vector of the heads' model and a present file, and how many have current scores. */
export async function moodProgress(): Promise<{ total: number; completed: number }> {
    const [row] = await prisma.$queryRaw<Array<{ total: number; completed: number }>>`
        SELECT count(*)::int AS total,
               (count(*) FILTER (
                   WHERE m.embedded_at = te.analyzed_at AND m.weights = ${MOOD_HEADS.version}
               ))::int AS completed
        FROM track_embeddings te
        JOIN "Track" t ON t.id = te.track_id
        LEFT JOIN track_moods m ON m.track_id = te.track_id
        WHERE te.model_version = ${MOOD_HEADS.model}
          AND t."missingSince" IS NULL
          AND vector_dims(te.embedding) = ${MOOD_HEADS.dims}
          AND vector_norm(te.embedding) > 0
    `;
    return row;
}
