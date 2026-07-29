/**
 * Album identity — the sibling of artistIdentity, for albums.
 *
 * SCOPE NOTE: this fixes duplicate albums. It deliberately does NOT retire the
 * `temp-<ts>-<random>` sentinel on `rgMbid`, even though that is the same
 * defect retired on Artist.mbid. `OwnedAlbum` and `DiscoveryAlbum` reference
 * albums by the rgMbid STRING VALUE rather than by a foreign key, so nulling
 * the sentinel would silently dangle every ownership row -- which drives the
 * "owned" artist filter and the artist-protection check in cleanup-lidarr.
 * Those two tables must move to an albumId FK first; the sentinel goes with
 * that change, not this one.
 *
 * `Album` models a MusicBrainz RELEASE GROUP (`rgMbid`), not an individual
 * release. That distinction decides the rules below: a remaster, a deluxe
 * edition and the original pressing are three releases of ONE release group,
 * so they must resolve to one Album row. "Abbey Road" and "Abbey Road (2019
 * Remaster)" are the same album.
 *
 * The defects this replaces:
 *
 *   - Lookup matched `title` raw and un-normalised, so "Abbey Road",
 *     "abbey road" and "Abbey Road (2019 Remaster)" became three rows under one
 *     artist. `stripAlbumEdition` already existed and was never called here.
 *   - `rgMbid` was the only UNIQUE column and was NOT NULL, so the scanner
 *     invented `temp-<ts>-<random>` when MusicBrainz gave nothing -- a
 *     guaranteed-unique value on the only unique column, which meant the
 *     database could never reject a duplicate. Same shape as the artist bug.
 *   - A cross-artist fallback matched on `title + year` across EVERY artist to
 *     keep compilations together. Its only guards were the literal strings
 *     "Unknown Album"/"Unknown" and a non-null year, so one artist's 1995
 *     "Greatest Hits" would absorb a different artist's 1995 "Greatest Hits".
 */

import { Prisma } from "@prisma/client";
import { stripAlbumEdition } from "../utils/artistNormalization";
import { foldIdentityText } from "./artistIdentity";

// Same rules as artist identity -- imported, not re-implemented, so the two
// cannot drift apart from each other or from the SQL backfill.
const stripDiacritics = foldIdentityText;

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
 * The dedupe key for an album title, scoped to its artist.
 *
 * Edition markers are stripped BEFORE the key is built, so every pressing of a
 * release group lands on one row -- which is what `Album` is supposed to be.
 *
 *   "Abbey Road" | "abbey road" | "Abbey Road (2019 Remaster)"  -> "abbeyroad"
 *   "( )"                                                        -> "" (see below)
 */
export function albumIdentityKey(title: string | null | undefined): string {
    if (title == null) return "";
    const base = stripAlbumEdition(String(title).trim());
    return stripDiacritics(base.toLowerCase()).replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Is this title too generic to be matched across artists?
 *
 * Compared on the edition-stripped, casefolded form so "The Best Of (Deluxe
 * Edition)" is caught alongside "best of".
 */
export function isGenericAlbumTitle(title: string | null | undefined): boolean {
    if (title == null) return true;
    const normalised = stripDiacritics(
        stripAlbumEdition(String(title).trim()).toLowerCase()
    )
        .replace(/\s+/g, " ")
        .trim();
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
    /** Applied only when a new row is created. */
    createData?: Prisma.AlbumUncheckedCreateInput extends infer T
        ? Omit<Prisma.AlbumUncheckedCreateInput, "artistId" | "title" | "rgMbid" | "identityKey">
        : never;
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
    // Sentinel retained until OwnedAlbum/DiscoveryAlbum stop keying on this
    // string value -- see the scope note at the top of this file.
    const rgMbid =
        input.rgMbid?.trim() || `temp-${Date.now()}-${Math.random()}`;
    const identityKey = albumIdentityKey(title) || `untitled-${input.artistId}`;

    if (rgMbid) {
        const byMbid = await db.album.findUnique({ where: { rgMbid } });
        if (byMbid) return byMbid;
    }

    const existing = await db.album.findUnique({
        where: {
            artistId_identityKey: { artistId: input.artistId, identityKey },
        },
    });
    if (existing) {
        if (input.rgMbid?.trim() && existing.rgMbid.startsWith("temp-")) {
            try {
                return await db.album.update({
                    where: { id: existing.id },
                    data: { rgMbid: input.rgMbid!.trim() },
                });
            } catch (error: any) {
                if (error?.code !== "P2002") throw error;
            }
        }
        return existing;
    }

    // Cross-artist reuse, for compilations ONLY. This keeps a VA release
    // together when albumartist tags disagree between its files. It previously
    // ran for EVERY album with a known year, which is how unrelated albums
    // sharing a title got merged.
    if (
        input.isCompilation &&
        input.year != null &&
        !isGenericAlbumTitle(title)
    ) {
        const shared = await db.album.findFirst({
            where: { identityKey, year: input.year, location: "LIBRARY" },
        });
        if (shared) return shared;
    }

    try {
        return await db.album.create({
            data: {
                ...(input.createData as any),
                artistId: input.artistId,
                title,
                identityKey,
                rgMbid,
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
