import { prisma } from "../../utils/db";
import { MATCHING_MODEL } from "../../services/matching/state";

/** A unit 512-dim vector with cosine `cos` to axis 0; no ties, so rankings are exact. */
export function unitVectorAt(cos: number, axis: number): string {
    return vectorLiteral(unitVectorValues(cos, axis));
}

/** The numbers behind `unitVectorAt`. */
export function unitVectorValues(cos: number, axis: number): number[] {
    const v = Array(512).fill(0);
    v[0] = cos;
    v[axis] = Math.sqrt(1 - cos * cos);
    return v;
}

/** pgvector's text form of `values`. */
export const vectorLiteral = (values: number[]) => `[${values.join(",")}]`;

/** The 512-dim unit vector along axis 0. */
export const AXIS_ZERO = vectorLiteral(Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)));

export async function seedEmbedding(trackId: string, vector: string) {
    // Mirrors services/audio-analyzer-clap/analyzer.py's insert shape
    // (%s::vector). Prisma cannot write Unsupported("vector") columns.
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, $3, now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        vector,
        MATCHING_MODEL,
    );
}

interface EmbeddingWrite {
    /** The embedding's model label; the matching model by default. */
    model?: string;
    /** Which Postgres clock stamps analyzed_at; clock_timestamp differs between rows of one transaction. */
    clock?: "now" | "clock_timestamp";
    /** Overwrite a track's existing vector instead of failing on it. */
    replace?: boolean;
}

/** Writes sound vectors (pgvector text form), 50 rows to a statement. */
export async function insertEmbeddings(rows: Array<{ trackId: string; vector: string }>, write: EmbeddingWrite = {}) {
    const { model = MATCHING_MODEL, clock = "now", replace = false } = write;
    for (let start = 0; start < rows.length; start += 50) {
        const chunk = rows.slice(start, start + 50);
        const values = chunk.map((_, j) => `($${3 * j + 1}, $${3 * j + 2}::vector, $${3 * j + 3}, ${clock}())`);
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ${values.join(",")}${
                 replace
                     ? ` ON CONFLICT (track_id) DO UPDATE SET embedding = EXCLUDED.embedding, analyzed_at = EXCLUDED.analyzed_at`
                     : ""
             }`,
            ...chunk.flatMap(({ trackId, vector }) => [trackId, vector, model]),
        );
    }
}
