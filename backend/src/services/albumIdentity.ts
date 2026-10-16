/**
 * Album identity, the sibling of artistIdentity. An Album is a MusicBrainz
 * release group, and only true duplicates merge: "Il Pozzo D'Amor" and "Il
 * Pozzo d'Amor" merge; "Playing the Angel (Deluxe)" stays separate.
 */

import { Prisma } from "@prisma/client";
import { foldIdentityText, artistSortName } from "./artistIdentity";
import { pgCollapseSpace, pgLower, pgTrim, stripNonAlnum } from "./pgTextRules";
import { LIBRARY_LOCATION } from "./libraryFilters";
import { musicBrainzService } from "./musicbrainz";
import { stripAlbumEdition } from "../utils/artistNormalization";
import { DuplicateMbidError, REPLACEABLE_SOURCES, isKimaChosen, reassignAlbumRgMbid } from "./mbidReassign";

/**
 * Titles too generic to identify a release group on their own. A cross-artist
 * match on any of these is almost certainly two different albums that happen to
 * share a name.
 */
const GENERIC_TITLES = new Set([
    "unknown album",
    "unknown",
    "untitled",
    "greatest hits",
    "the greatest hits",
    "best of",
    "the best of",
    "hits",
    "singles",
    "demos",
    "live",
    "ep",
    "compilation",
    "various",
    "self titled",
    "s/t",
]);

/**
 * The album's dedupe key within its artist: case, punctuation, accents and
 * unicode variants fold; edition markers stay. "Il Pozzo D'Amor" -> "ilpozzodamor",
 * "Playing the Angel (Deluxe)" -> "playingtheangel(deluxe)".
 */
export function albumIdentityKey(title: string | null | undefined): string {
    if (title == null) return "";
    return stripNonAlnum(pgLower(foldIdentityText(pgTrim(String(title)))));
}

/**
 * The key that decides whether owning one title covers another: edition markers
 * drop, so "Antics (Deluxe)" covers "Antics". Compare whole keys, never
 * substrings: owning "Trance" must not cover "Trust In Trance".
 */
export function editionlessKey(title: string | null | undefined): string {
    return albumIdentityKey(stripAlbumEdition(title ?? ""));
}

/**
 * Is this title too generic to be matched across artists? Compared casefolded, so
 * "The Best Of" is caught alongside "best of"; edition markers are kept, so
 * "Best Of (Deluxe)" and "Best Of" are distinct titles.
 */
export function isGenericAlbumTitle(title: string | null | undefined): boolean {
    if (title == null) return true;
    const normalised = pgTrim(
        pgCollapseSpace(pgLower(foldIdentityText(pgTrim(String(title)))))
    );
    // Emptiness is judged on the identity key, not on this spacing-preserving
    // form: "( )" is non-empty here but collapses to "" as a key, and a title
    // with no identity is exactly the case that must not match across artists.
    return (
        normalised === "" ||
        albumIdentityKey(title) === "" ||
        GENERIC_TITLES.has(normalised)
    );
}

export interface ResolveAlbumInput {
    artistId: string;
    title: string;
    /** MusicBrainz release-group id, when the source supplied one. */
    rgMbid?: string | null;
    year?: number | null;
    /**
     * True when the tags say this is a compilation. Only then may an album be
     * shared across artists -- that is the case the cross-artist fallback was
     * written for, and the only one where it is safe.
     */
    isCompilation?: boolean;
    /**
     * Extra fields for a NEW row. A function is accepted so a caller whose
     * create-only work is expensive -- the scanner runs several queries to
     * decide DISCOVER vs LIBRARY -- does not pay for it on a lookup hit.
     */
    createData?:
        | Omit<Prisma.AlbumUncheckedCreateInput, "artistId" | "title" | "rgMbid" | "identityKey">
        | (() => Promise<
              Omit<Prisma.AlbumUncheckedCreateInput, "artistId" | "title" | "rgMbid" | "identityKey">
          >);
}

type AlbumClient = Pick<Prisma.TransactionClient, "album">;

/**
 * The ONLY place an album row is looked up or created.
 *
 * Order: release-group id first (authoritative), then the identity key scoped
 * to the artist, then -- for compilations only -- a cross-artist match.
 */
export async function resolveAlbum(
    db: AlbumClient,
    input: ResolveAlbumInput
) {
    const title = String(input.title ?? "").trim() || "Unknown Album";
    // rgMbid is required and unique, so an album with no release-group id gets a throwaway one.
    const rgMbid =
        input.rgMbid?.trim() || `temp-${Date.now()}-${Math.random()}`;
    const identityKey = albumIdentityKey(title) || `untitled-${input.artistId}`;

    const byMbid = await db.album.findUnique({ where: { rgMbid } });
    if (byMbid) {
        // A file's tag confirming an id Kima chose makes it the files' own.
        if (input.rgMbid?.trim() && isKimaChosen(byMbid.rgMbidSource)) {
            // Only while the source is still Kima's: a person's edit meanwhile is kept.
            await db.album.updateMany({
                where: { id: byMbid.id, rgMbidSource: { in: [...REPLACEABLE_SOURCES] } },
                data: { rgMbidSource: "tag" },
            });
            return (await db.album.findUnique({ where: { id: byMbid.id } })) ?? byMbid;
        }
        return byMbid;
    }

    const existing = await db.album.findUnique({
        where: {
            artistId_identityKey: { artistId: input.artistId, identityKey },
        },
    });
    if (existing) {
        // The file's own release-group tag replaces a placeholder, or an id Kima chose (the
        // AcoustID vote, a name search); never one from tags or a person. Rows keyed on the old id
        // move too, in their own transaction (the scanner passes the global client).
        const tagged = input.rgMbid?.trim();
        if (tagged && (existing.rgMbid.startsWith("temp-") || isKimaChosen(existing.rgMbidSource))) {
            try {
                await reassignAlbumRgMbid(existing.id, tagged, { source: "tag", expectedOld: existing.rgMbid });
            } catch (error) {
                if (!(error instanceof DuplicateMbidError)) throw error;
            }
            // Moved, or changed meanwhile by someone else: either way the row as it is now.
            return (await db.album.findUnique({ where: { id: existing.id } })) ?? existing;
        }
        return existing;
    }

    // Cross-artist reuse for compilations only, keeping a VA release together
    // when its files' albumartist tags disagree.
    if (
        input.isCompilation &&
        input.year != null &&
        !isGenericAlbumTitle(title)
    ) {
        const shared = await db.album.findFirst({
            where: { identityKey, year: input.year, location: LIBRARY_LOCATION },
        });
        if (shared) return shared;
    }

    const extra =
        typeof input.createData === "function"
            ? await input.createData()
            : input.createData;

    try {
        return await db.album.create({
            data: {
                ...(extra as any),
                artistId: input.artistId,
                title,
                identityKey,
                // The canonical title; a later display override updates sortName itself.
                sortName: artistSortName(title),
                rgMbid,
                rgMbidSource: input.rgMbid?.trim() ? "tag" : null,
                year: input.year ?? null,
            },
        });
    } catch (error: any) {
        if (error?.code === "P2002") {
            const raced =
                (await db.album.findUnique({
                    where: {
                        artistId_identityKey: {
                            artistId: input.artistId,
                            identityKey,
                        },
                    },
                })) ??
                (rgMbid ? await db.album.findUnique({ where: { rgMbid } }) : null);
            if (raced) return raced;
        }
        throw error;
    }
}

/**
 * Whether two album titles name the same record: exact, punctuation-insensitive,
 * then without edition markers. Checks candidates only; it never renames, so
 * "Playing the Angel (Deluxe)" stays distinct locally.
 */
export function titlesAgree(a: string, b: string): boolean {
    const bare = (t: string) => foldTitle(musicBrainzService.normalizeForSearch(t));
    if (!a || !b) return false;
    // Identical text is the same title even when nothing survives the fold
    // (an album called "!!!"); the empty-fold guard below is for DIFFERENT text.
    const exact = (t: string) => t.normalize("NFKC").toLowerCase().trim();
    if (exact(a) !== "" && exact(a) === exact(b)) return true;
    const same = (x: string, y: string) => x !== "" && x === y;
    return same(foldTitle(a), foldTitle(b)) || same(bare(a), bare(b));
}

/**
 * Keep the letters, numbers and combining marks of any script (marks change
 * words in Devanagari, Thai, Japanese), dropping only Latin accents so "Café"
 * matches "Cafe". An empty fold never agrees with anything.
 */
function foldTitle(t: string): string {
    return t
        .normalize("NFKD")
        .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}
