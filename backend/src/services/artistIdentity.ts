/**
 * Artist identity — the single source of truth for deciding whether two artist
 * strings refer to the same artist.
 *
 * This replaces a heuristic that tried to guess where a band name ended by
 * splitting on " & ", " and ", " with " and ", ". It could not work: those
 * separators occur inside band names at least as often as they mark a
 * collaboration, and no length or word-count rule separates the two. Measured
 * against real names it truncated "Dance With the Dead" to "Dance", "Nick Cave
 * & The Bad Seeds" to "Nick Cave", and "Florence and the Machine" to
 * "Florence". The truncated name was then persisted and became the artist.
 *
 * The rules here are deliberately boring:
 *
 *   - Never split on an ambiguous separator. If the tags do not tell us there
 *     are multiple artists, there is one artist.
 *   - Do the collapsing BEFORE the value is used as a lookup key, so the
 *     database can enforce uniqueness instead of a candidate scan guessing at
 *     it afterwards. `identityKey` is what makes "deadmau5" and "dead mau5"
 *     the same row by construction rather than by a fuzzy score that happened
 *     to land above a threshold.
 */

import { Prisma } from "@prisma/client";
import { canonicalizeVariousArtists } from "../utils/artistNormalization";
import {
    PG_LEADING_ARTICLE,
    pgCollapseSpace,
    pgLower,
    pgTrim,
    stripNonAlnum,
    unaccent,
} from "./pgTextRules";

/** Separators that unambiguously mark multiple artists in a tag value. */
const STRUCTURAL_SPLIT = /[\0;]+/;

/**
 * Featured-artist annotations. These are credit markers, not artist
 * boundaries: the text after them is a separate performer, and the text
 * BEFORE them is the primary artist and must survive intact.
 */
const FEATURED_MARKER =
    /\s+(?:feat\.?|ft\.?|featuring|w\/)\s+/i;


/**
 * Casefold-safe text normalisation shared by every identity key in the app.
 * Exported so album identity uses the SAME rules; a second copy would drift.
 *
 * This is `unaccent()` and nothing else, because the identity keys are computed
 * in two places -- here at scan time and in SQL by the migration backfills --
 * and any disagreement makes a backfilled key unreachable from the runtime, so
 * the next scan re-creates the duplicate the mechanism exists to prevent.
 *
 * It used to be NFD + strip-combining-marks + a 20-entry hand-written table of
 * "characters unaccent folds that carry no combining mark". That approach
 * cannot work: it diverged from `unaccent()` on 857 of 2624 sampled codepoints,
 * and the two are not the same KIND of operation. `unaccent()` strips a bare
 * combining mark but leaves composed kana intact, where NFD-then-strip turns
 * \u304C into \u304B. The table is now generated from the shipped Postgres
 * image (see unaccentFold.ts), so the two sides agree by construction.
 */
export function foldIdentityText(value: string): string {
    return unaccent(value);
}

function stripDiacritics(value: string): string {
    return foldIdentityText(value);
}

/**
 * Case/accent-insensitive form used for display-adjacent comparisons.
 * Keeps word boundaries, so "deadmau5" and "dead mau5" still differ here --
 * that is what `artistIdentityKey` is for.
 */
export function normalizeArtistName(name: string | null | undefined): string {
    if (name == null) return "";
    // Fold BEFORE lowercasing, because SQL does lower(unaccent(x)) and some
    // unaccent expansions are uppercase -- (c) is folded to "(C)", (r) to
    // "(R)". Lowercasing first left that C uppercase, and the key built from
    // it could never match the backfilled one.
    return pgTrim(
        pgCollapseSpace(
            pgLower(stripDiacritics(pgTrim(name))).replace(/\s*&\s*/g, " and ")
        )
    );
}

/**
 * The dedupe key. Everything that does not change WHO the artist is gets
 * removed: case, accents, punctuation, and all whitespace.
 *
 *   "deadmau5" | "Dead Mau5" | "dead mau5"  -> "deadmau5"
 *   "Sigur Rós" | "Sigur Ros"               -> "sigurros"
 *   "AC/DC" | "AC-DC" | "ACDC"              -> "acdc"
 *
 * Used as a UNIQUE column, so a second row for the same artist is rejected by
 * Postgres rather than depending on the lookup code being clever.
 */
export function artistIdentityKey(name: string | null | undefined): string {
    return stripNonAlnum(normalizeArtistName(name));
}

/**
 * Collation-friendly sort value: article-stripped, unaccented, lowercased.
 * "The Beatles" -> "beatles", "Björk" -> "bjork".
 */
export function artistSortName(name: string | null | undefined): string {
    if (name == null) return "";
    const base = pgCollapseSpace(pgLower(stripDiacritics(pgTrim(name))));
    return pgTrim(base.replace(PG_LEADING_ARTICLE, "")) || base;
}

/**
 * Does this artist carry a usable MusicBrainz id?
 *
 * "Unknown" is now expressed as NULL. The `temp-<ts>-<rand>` prefix is still
 * accepted because a row written before the sentinel was retired may survive a
 * partially-applied migration -- it was never a real id, so it must not be sent
 * to MusicBrainz either way.
 *
 * Narrows the type, so callers get a plain `string` inside the guard.
 */
export function hasRealMbid(
    mbid: string | null | undefined
): mbid is string {
    return typeof mbid === "string" && mbid.length > 0 && !mbid.startsWith("temp-");
}

export interface ParsedCredit {
    /** The performing artist, never truncated. */
    primary: string;
    /** Additional credited performers, in tag order. */
    featured: string[];
}

/**
 * Turn a raw artist tag into a primary artist plus featured credits.
 *
 * Prefers structured tag data when the caller has it: `music-metadata` exposes
 * multi-value artist frames, which already carry the split this used to try to
 * reverse-engineer out of a joined string.
 *
 * When only a joined string is available it splits ONLY on separators that are
 * unambiguous (the ID3v2.4 null separator and ";"), and treats feat./ft./
 * featuring as annotations that peel off the tail while leaving the primary
 * intact. It never splits on "&", "and", "with", "," or "x".
 */
export function parseCredit(
    raw: string | null | undefined,
    multiValue?: readonly string[] | null
): ParsedCredit {
    const values = (
        multiValue && multiValue.length > 1
            ? multiValue
            : String(raw ?? "").split(STRUCTURAL_SPLIT)
    )
        .map((v) => v.trim())
        .filter(Boolean);

    if (values.length === 0) {
        return { primary: "", featured: [] };
    }

    const featured: string[] = [];

    // Peel featured credits off the FIRST value only; later values are already
    // separate artists.
    const [head, ...tail] = values;
    const parts = head.split(FEATURED_MARKER);
    const primaryRaw = parts[0].trim();
    for (const extra of parts.slice(1)) {
        const cleaned = extra.trim();
        if (cleaned) featured.push(cleaned);
    }

    for (const value of tail) {
        const sub = value.split(FEATURED_MARKER);
        for (const piece of sub) {
            const cleaned = piece.trim();
            if (cleaned) featured.push(cleaned);
        }
    }

    return {
        primary: canonicalizeVariousArtists(primaryRaw),
        featured,
    };
}

export interface ResolveArtistInput {
    /** Raw artist name as credited. */
    name: string;
    /** MusicBrainz artist id, when the source supplied one. */
    mbid?: string | null;
}

type ArtistClient = Pick<Prisma.TransactionClient, "artist">;

/**
 * The ONLY place an artist row is looked up or created.
 *
 * Order matters: the MusicBrainz id is checked FIRST because it is the
 * authoritative identifier. The previous code consulted it last, after a fuzzy
 * name match, so a track carrying a correct MBID could be attached to a
 * 95%-similar wrong artist before its own id was ever read.
 *
 * There is no fuzzy matching here at all. Near-miss unification ("the weeknd"
 * vs "the weekend") is a maintenance concern, not a per-file one -- doing it
 * during a scan means every scanned track pays for an unbounded candidate
 * query and a wrong guess is written to disk permanently.
 */
export async function resolveArtist(
    db: ArtistClient,
    input: ResolveArtistInput
) {
    const name = canonicalizeVariousArtists(String(input.name ?? "").trim());
    if (!name) {
        throw new Error("resolveArtist requires a non-empty artist name");
    }

    const mbid = input.mbid?.trim() || null;
    const identityKey = artistIdentityKey(name);

    if (mbid) {
        const byMbid = await db.artist.findUnique({ where: { mbid } });
        if (byMbid) return byMbid;
    }

    const existing = await db.artist.findUnique({ where: { identityKey } });
    if (existing) {
        // Backfill the MBID onto a row created before we knew it. Tolerate the
        // unique violation: a concurrent scan may have claimed it first, in
        // which case the row we have is still the right one to return.
        if (mbid && !existing.mbid) {
            try {
                return await db.artist.update({
                    where: { id: existing.id },
                    data: { mbid },
                });
            } catch (error: any) {
                if (error?.code !== "P2002") throw error;
            }
        }
        return existing;
    }

    try {
        return await db.artist.create({
            data: {
                name,
                mbid,
                identityKey,
                normalizedName: normalizeArtistName(name),
                sortName: artistSortName(name),
            },
        });
    } catch (error: any) {
        // Lost a race on identityKey or mbid -- re-read rather than fail the scan.
        if (error?.code === "P2002") {
            const raced =
                (await db.artist.findUnique({ where: { identityKey } })) ??
                (mbid ? await db.artist.findUnique({ where: { mbid } }) : null);
            if (raced) return raced;
        }
        throw error;
    }
}
