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

/**
 * Spaces (any width, no-break included), hyphens, dashes and the minus sign, underscores, slashes, dots and middle dots,
 * apostrophes, and the invisible soft hyphen, zero-width space and byte-order mark.
 */
const GENRE_KEY_STRIP = "[[:space:]\u00a0\u202f\u00ad\u200b\ufeff_/.\u00b7'\u2018\u2019\u2010-\u2015\u2043\u2212-]+";

/**
 * A genre name as one genre: in one Unicode form (an accent typed as its own mark reads as the accented letter, a
 * full-width hyphen as a hyphen), lower-cased, without the characters above, so "Hip Hop", "hip-hop" and "HipHop"
 * read as one (#235). Letters of every script are kept, so different words stay apart; a name made only of the
 * characters above has the key ''. `name` is a SQL expression or a bound value.
 */
export function genreKeySql(name: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`regexp_replace(LOWER(normalize(${name}, NFKC)), ${GENRE_KEY_STRIP}, '', 'g')`;
}

/** A genre name typed by a person, for `LIKE … ESCAPE '\'`: % and \ are letters, not patterns. */
export function likeLiteral(value: string): string {
    return value.replace(/[\\%]/g, "\\$&");
}
