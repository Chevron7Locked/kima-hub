/**
 * The one way Kima folds a name for comparison: Postgres `lower(unaccent())` (pgTextRules), the fold the stored artist
 * and album keys are built with, after composing decomposed text (NFC), so a name stored decomposed (a macOS file name,
 * a tag) compares equal to its usual form. For text already composed it is the stored album key. Letters and digits of
 * every script survive; case, accents, punctuation and marks like ™ do not.
 */
import { pgLower, pgTrim, stripNonAlnum, unaccent } from "./pgTextRules";

/**
 * A name as one key: "Sigur Rós" -> "sigurros", "AC/DC" -> "acdc", "Straße" -> "strasse". A name with no letters or
 * digits has no key ("").
 */
export function nameKey(name: string | null | undefined): string {
    return stripNonAlnum(pgLower(unaccent(pgTrim((name ?? "").normalize("NFC")))));
}

/**
 * The same fold with the words kept apart, for word search and fuzzy matching: "Sigur Rós" -> "sigur ros",
 * "Don't Stop" -> "dont stop", "Jay-Z" -> "jayz". Punctuation inside a word joins it rather than splitting it; any
 * kind of space splits words.
 */
export function nameWords(name: string | null | undefined): string {
    return pgLower(unaccent((name ?? "").normalize("NFC")))
        .split(/\s+/)
        .map(stripNonAlnum)
        .filter(Boolean)
        .join(" ");
}
