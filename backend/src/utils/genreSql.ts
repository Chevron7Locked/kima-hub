/**
 * Genre columns read in SQL. They are JSON and can hold anything: only a JSON array counts as a list of genres, and
 * anything else (a bare string, an object, JSON null) reads as an empty list, so jsonb_array_elements_text never fails
 * on it. The SQL twin of the rule getMergedGenres applies in TypeScript (utils/metadataOverrides.ts).
 */
import { Prisma } from "@prisma/client";

const asArray = (column: string) => `CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END`;

/** The JSON column `column` (a fixed SQL reference such as `ar.genres`, never request input) as a jsonb array. */
export function genreArraySql(column: string): Prisma.Sql {
    return Prisma.raw(asArray(column));
}

/**
 * The genres of the artist under SQL alias `alias`, for filtering by genre: the ones a person set when there are any,
 * else the enriched ones.
 */
export function artistGenresSql(alias: string): Prisma.Sql {
    const user = `${alias}."userGenres"`;
    return Prisma.raw(
        `CASE WHEN jsonb_typeof(${user}) = 'array' AND jsonb_array_length(${user}) > 0 THEN ${user} ` +
            `ELSE ${asArray(`${alias}.genres`)} END`
    );
}
