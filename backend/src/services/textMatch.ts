/**
 * Case-insensitive substring search for any script. Postgres on SQL_ASCII (what real installs use) folds case for
 * ASCII letters only, so a query holding a non-ASCII letter ("björk", "ддт") gets a pattern built here that lists every
 * case form of each letter, and Postgres matches that pattern and pages the ids.
 */

/** Whether the text holds any character outside ASCII, which the database cannot fold case for. */
export const hasNonAscii = (text: string): boolean => /[^\x00-\x7f]/.test(text);

/** Whether `text` holds `query`, ignoring letter case in every script. */
export const containsText = (text: string | null | undefined, query: string): boolean =>
    (text ?? "").normalize("NFC").toLowerCase().includes(query.normalize("NFC").toLowerCase());

const REGEX_SPECIAL = /[\\^$.|?*+()[\]{}]/;

/** The characters a stored letter can be written as for `c`: itself, lower case and upper case. */
const caseForms = (c: string): string[] =>
    [...new Set([c, c.toLowerCase(), c.toUpperCase()])].filter((f) => [...f].length === 1);

/** A regular expression for `text` that ignores letter case, one character at a time. */
const caseBlindRegex = (text: string): string =>
    [...text]
        .map((c) => {
            const forms = caseForms(c).map((f) => (REGEX_SPECIAL.test(f) ? `\\${f}` : f));
            return forms.length === 1 ? forms[0] : `(?:${forms.join("|")})`;
        })
        .join("");

/**
 * A Postgres regular expression that matches any text holding `query`, ignoring letter case in every script. Postgres
 * on SQL_ASCII folds ASCII case only, so each letter is written out as the forms it can take. The query is also tried
 * in its decomposed form (the accent as a separate character), the other way the same text can be stored.
 */
export function foldedPattern(query: string): string {
    const composed = query.normalize("NFC");
    const decomposed = query.normalize("NFD");
    return composed === decomposed
        ? caseBlindRegex(composed)
        : `(?:${caseBlindRegex(composed)}|${caseBlindRegex(decomposed)})`;
}

/**
 * One page of matching rows, in the order `idsOf` gives. An ASCII query is answered by `ascii` (the database's own
 * case-insensitive match, page and all). Any other query asks `idsOf` for the page's ids, which the database finds with
 * `foldedPattern`, then `load` reads only those rows. The ids come back at most `limit` at a time.
 */
export async function searchRows<T extends { id: string }>(
    query: string,
    limit: number,
    offset: number,
    ascii: (page: { skip: number; take: number }) => Promise<T[]>,
    idsOf: (pattern: string, page: { skip: number; take: number }) => Promise<{ id: string }[]>,
    load: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
    if (!hasNonAscii(query)) return ascii({ skip: offset, take: limit });
    const ids = (await idsOf(foldedPattern(query), { skip: offset, take: limit })).map((r) => r.id);
    if (ids.length === 0) return [];
    const byId = new Map((await load(ids)).map((row) => [row.id, row]));
    return ids.flatMap((id) => byId.get(id) ?? []);
}
