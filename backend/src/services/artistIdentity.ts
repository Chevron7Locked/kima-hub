/**
 * Artist identity: whether two artist strings name the same artist. It never
 * splits on ambiguous separators ("&", "and", "with", ","), which occur inside
 * band names as often as between collaborators, and it collapses names into a
 * key before lookup so Postgres enforces uniqueness.
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
 * Text folding shared by every identity key: Postgres `unaccent()` exactly
 * (from pgTextRules), because the same keys are also computed in SQL backfills
 * and must agree character for character.
 */
export function foldIdentityText(value: string): string {
    return unaccent(value);
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
            pgLower(foldIdentityText(pgTrim(name))).replace(/\s*&\s*/g, " and ")
        )
    );
}

/**
 * The dedupe key, stored in a UNIQUE column: case, accents, punctuation and
 * whitespace removed. "Dead Mau5" -> "deadmau5", "Sigur Rós" -> "sigurros",
 * "AC/DC" -> "acdc".
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
    const base = pgCollapseSpace(pgLower(foldIdentityText(pgTrim(name))));
    return pgTrim(base.replace(PG_LEADING_ARTICLE, "")) || base;
}

/**
 * The artists named `name`, found by the identity key the scanner stores (built in TypeScript, so it folds case and
 * accents of every script the same on any database encoding). A name with no letters or digits has no key, so it is
 * matched exactly.
 */
export function artistNamed(name: string): Prisma.ArtistWhereInput {
    const identityKey = artistIdentityKey(name);
    return identityKey ? { identityKey } : { name };
}

const MBID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a value shaped like a MusicBrainz id; temp- and row ids fail. */
export function isMbid(value: unknown): value is string {
    return typeof value === "string" && MBID_FORMAT.test(value);
}


export interface ParsedCredit {
    /** The performing artist, never truncated. */
    primary: string;
    /** Additional credited performers, in tag order. */
    featured: string[];
}

/**
 * Split an artist tag into a primary artist and featured credits. Prefers
 * multi-value tag frames; a joined string splits only on unambiguous separators
 * (ID3v2.4 null, ";"), with feat./ft./featuring peeled off the end.
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
 * The only place an artist row is looked up or created. The MusicBrainz id is
 * checked first. No fuzzy matching: a wrong guess during a scan is permanent,
 * so near-miss merging is a maintenance job.
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
