/**
 * The similarity enrichment step.
 * Per track it stores the feel probe's output for the sound vector it was computed
 * from; per library it stores the formula's statistics, rebuilt in full whenever
 * the eligible tracks, their sound vectors or their artists' genres change.
 */
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { formatEmbedding } from "../../utils/embedding";
import { getMergedGenres } from "../../utils/metadataOverrides";
import feelProbe from "./feelProbe.json";
import mbGenres from "./mbGenres.json";
import { buildGenreModel, genreWeight, type FeelStats, type GenreModel } from "./formula";

/** Raise when the formula's arithmetic changes, so every library rebuilds its state. */
const FORMULA_VERSION = 1;

/** The sound model the feel probe was fitted on; vectors from any other model are not matched. */
export const MATCHING_MODEL = feelProbe.model;

export const PROBE_ID = crypto
    .createHash("sha256")
    .update(JSON.stringify([feelProbe.model, feelProbe.valence, feelProbe.arousal]))
    .digest("hex")
    .slice(0, 16);

const PROBE_DIMS = feelProbe.valence.weights.length;
export const STATE_VERSION = `${FORMULA_VERSION}/${MATCHING_MODEL}/${PROBE_ID}`;
/**
 * How long each writer of the matching state waits on the others. These are chosen limits, not measured ones,
 * and they must stay in this order: a re-run outwaits a build holding the state row, and a map write outwaits a
 * re-run, or the later writer gives up while the earlier still holds the row.
 */
export const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
export const RERUN_TIMEOUT_MS = BUILD_TIMEOUT_MS + 2 * 60 * 1000;
export const MAP_WRITE_TIMEOUT_MS = RERUN_TIMEOUT_MS + 60 * 1000;

/** The comparison the formula was measured with: lower-case letters and digits only. */
function genreKey(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MB_GENRE = new Map<string, string>();
for (const name of mbGenres.genres) {
    const key = genreKey(name);
    if (!MB_GENRE.has(key)) MB_GENRE.set(key, name.toLowerCase());
}

/** An artist's genres (getMergedGenres: the person's list when they set one, else the enriched one) that are MusicBrainz genres, each in MusicBrainz's spelling. */
export function matchingGenres(artist: { genres?: unknown; userGenres?: unknown }): string[] {
    const names = new Set<string>();
    for (const tag of getMergedGenres(artist)) {
        if (typeof tag !== "string") continue;
        const name = MB_GENRE.get(genreKey(tag));
        if (name) names.add(name);
    }
    return [...names];
}

export interface MatchingState {
    trackCount: number;
    feel: FeelStats;
    soundSpread: number;
    genreSpread: number;
    genreWeight: number;
    genres: GenreModel;
}

/** The library's state, or null until the similarity step has built one for this formula and probe. */
export async function loadMatchingState(): Promise<MatchingState | null> {
    const row = await prisma.matchingState.findUnique({ where: { id: "default" } });
    if (!row || row.version !== STATE_VERSION) return null;
    return {
        trackCount: row.trackCount,
        feel: {
            mean: [row.feelMeanValence, row.feelMeanArousal],
            sd: [row.feelSdValence, row.feelSdArousal],
        },
        soundSpread: row.soundSpread,
        genreSpread: row.genreSpread,
        genreWeight: row.genreWeight,
        genres: row.genres as unknown as GenreModel,
    };
}

/** Feel for every sound vector of the probe's model that has none, an older one, or one from another probe. */
async function updateFeel(tx: Prisma.TransactionClient): Promise<number> {
    const valence = formatEmbedding(feelProbe.valence.weights);
    const arousal = formatEmbedding(feelProbe.arousal.weights);
    return tx.$executeRaw`
        WITH stale AS MATERIALIZED (
            SELECT te.track_id
            FROM track_embeddings te
            LEFT JOIN matching_feel f ON f.track_id = te.track_id
            WHERE te.model_version = ${MATCHING_MODEL}
              -- Library songs only: a Discover song is never scored.
              AND EXISTS (SELECT 1 FROM "Track" lt JOIN "Album" la ON la.id = lt."albumId"
                          WHERE lt.id = te.track_id AND la.location = 'LIBRARY')
              AND (f.track_id IS NULL
                   OR f.embedded_at IS DISTINCT FROM te.analyzed_at
                   OR f.probe IS DISTINCT FROM ${PROBE_ID})
        )
        INSERT INTO matching_feel (track_id, embedded_at, probe, valence, arousal)
        SELECT te.track_id, te.analyzed_at, ${PROBE_ID},
               LEAST(1, GREATEST(0, -(te.embedding <#> ${valence}::vector) / vector_norm(te.embedding) + ${feelProbe.valence.bias}::float8)),
               LEAST(1, GREATEST(0, -(te.embedding <#> ${arousal}::vector) / vector_norm(te.embedding) + ${feelProbe.arousal.bias}::float8))
        FROM stale s
        JOIN track_embeddings te ON te.track_id = s.track_id
        WHERE vector_dims(te.embedding) = ${PROBE_DIMS} AND vector_norm(te.embedding) > 0
        ON CONFLICT (track_id) DO UPDATE
        SET embedded_at = EXCLUDED.embedded_at,
            probe = EXCLUDED.probe,
            valence = EXCLUDED.valence,
            arousal = EXCLUDED.arousal
    `;
}

/** Changes whenever an eligible track, its sound vector, its artist or that artist's genres change. */
async function inputsFingerprint(tx: Prisma.TransactionClient): Promise<string> {
    const [row] = await tx.$queryRaw<Array<{ n: number; h: string }>>`
        SELECT count(*)::int AS n,
               COALESCE(sum(hashtextextended(
                   te.track_id || ':' || extract(epoch FROM te.analyzed_at)::text || ':' || ar.id || ':' ||
                   COALESCE(ar.genres::text, '') || ':' || COALESCE(ar."userGenres"::text, ''), 0)), 0)::text AS h
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID}
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        WHERE te.model_version = ${MATCHING_MODEL} AND t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')
    `;
    return crypto.createHash("sha256").update(JSON.stringify([STATE_VERSION, row.n, row.h])).digest("hex");
}

type StateColumns = Omit<Prisma.MatchingStateCreateInput, "id" | "version" | "fingerprint" | "builtAt">;

/** The library statistics, or null when no track is eligible. */
async function computeState(tx: Prisma.TransactionClient): Promise<StateColumns | null> {
    const [stats] = await tx.$queryRaw<
        Array<{ n: number; mv: number; ma: number; sv: number; sa: number; meanNorm: number }>
    >`
        SELECT count(*)::int AS n,
               avg(f.valence ORDER BY te.track_id) AS mv, avg(f.arousal ORDER BY te.track_id) AS ma,
               stddev_pop(f.valence ORDER BY te.track_id) AS sv, stddev_pop(f.arousal ORDER BY te.track_id) AS sa,
               vector_norm(avg(l2_normalize(te.embedding) ORDER BY te.track_id)) AS "meanNorm"
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID}
        JOIN "Track" t ON t.id = te.track_id
        WHERE te.model_version = ${MATCHING_MODEL} AND t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')
    `;
    if (stats.n === 0) return null;

    const artists = await tx.$queryRaw<
        Array<{ artistId: string; tracks: number; genres: unknown; userGenres: unknown }>
    >`
        SELECT ar.id AS "artistId", count(*)::int AS tracks, ar.genres, ar."userGenres"
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID}
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        WHERE te.model_version = ${MATCHING_MODEL} AND t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')
        GROUP BY ar.id
    `;
    const soundSpread = 1 - stats.meanNorm * stats.meanNorm;
    const { model, spread } = buildGenreModel(
        artists.map((a) => ({ artistId: a.artistId, tracks: a.tracks, genres: matchingGenres(a) })),
    );
    return {
        trackCount: stats.n,
        feelMeanValence: stats.mv,
        feelMeanArousal: stats.ma,
        feelSdValence: stats.sv,
        feelSdArousal: stats.sa,
        soundSpread,
        genreSpread: spread,
        genreWeight: genreWeight(soundSpread, spread),
        genres: model as unknown as Prisma.InputJsonValue,
    };
}

/**
 * One run of the step: feel for new or changed sound vectors, then the library state
 * when its inputs changed. One transaction, so a search never sees feel from one
 * probe with statistics from another.
 */
export async function buildMatching(): Promise<{ feelUpdated: number; rebuilt: boolean }> {
    try {
        return await build();
    } catch (error) {
        // A re-run or map write changed the state row while this build waited for it: what it read is out of date,
        // so nothing is written and the next pass builds from the new data.
        if (isWriteConflict(error)) {
            logger.info("[Matching] State changed while the build waited; the next pass rebuilds it");
            return { feelUpdated: 0, rebuilt: false };
        }
        throw error;
    }
}

/** Postgres refused the transaction because of another one (serialization 40001, deadlock 40P01), as Prisma reports it. */
export function isWriteConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code === "P2034") return true;
    const pgCode = (error.meta as { code?: string } | undefined)?.code;
    return error.code === "P2010" && (pgCode === "40001" || pgCode === "40P01");
}

function build(): Promise<{ feelUpdated: number; rebuilt: boolean }> {
    return prisma.$transaction(
        async (tx) => {
            // The state row first, as every re-run and map write takes it, before the feel rows that lock sound vectors:
            // one order, so none of them deadlock.
            await tx.$queryRaw`SELECT id FROM matching_state WHERE id = 'default' FOR UPDATE`;
            const feelUpdated = await updateFeel(tx);
            const fingerprint = await inputsFingerprint(tx);
            const current = await tx.matchingState.findUnique({
                where: { id: "default" },
                select: { version: true, fingerprint: true },
            });
            if (current?.version === STATE_VERSION && current.fingerprint === fingerprint) {
                return { feelUpdated, rebuilt: false };
            }
            const state = await computeState(tx);
            if (!state) {
                await tx.matchingState.deleteMany({});
                return { feelUpdated, rebuilt: false };
            }
            const columns = { version: STATE_VERSION, fingerprint, ...state, builtAt: new Date() };
            await tx.matchingState.upsert({
                where: { id: "default" },
                create: { id: "default", ...columns },
                update: columns,
            });
            return { feelUpdated, rebuilt: true };
        },
        {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            timeout: BUILD_TIMEOUT_MS,
            maxWait: BUILD_TIMEOUT_MS,
        },
    );
}

/**
 * Tracks with a sound vector of the probe's model and a present file, and how many of them the similarity step has
 * finished: current feel and a current place on the map.
 */
export async function matchingProgress(): Promise<{ total: number; completed: number }> {
    const [row] = await prisma.$queryRaw<Array<{ total: number; completed: number }>>`
        SELECT count(*)::int AS total,
               (count(*) FILTER (
                   WHERE f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID} AND m.embedded_at = te.analyzed_at
               ))::int AS completed
        FROM track_embeddings te
        JOIN "Track" t ON t.id = te.track_id
        LEFT JOIN matching_feel f ON f.track_id = te.track_id
        LEFT JOIN matching_map m ON m.track_id = te.track_id
        WHERE te.model_version = ${MATCHING_MODEL}
          AND t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')
          AND vector_dims(te.embedding) = ${PROBE_DIMS}
          AND vector_norm(te.embedding) > 0
    `;
    return row;
}
