/**
 * Library-scope filters. DISCOVER albums are suggestions, not owned, so a query
 * limited to owned content spreads one of these into its `where`.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { PLAYABLE_SONG, assertSqlName, playableSongSql } from "../utils/playableSong";

/** `Album.location` for owned albums. */
export const LIBRARY_LOCATION = "LIBRARY";

/**
 * A library album with at least one playable song. Lists of albums and artists show only these: an album whose every
 * file is missing or unreadable has nothing to play, so it is left out until a file comes back.
 */
export const PLAYABLE_ALBUM_WHERE: Prisma.AlbumWhereInput = {
    location: LIBRARY_LOCATION,
    tracks: { some: PLAYABLE_SONG },
};

/** The outer query's table name or alias, checked before it is written into SQL. `ps` and `pa` are the inner aliases
 * these pieces use, so an outer name of either would be shadowed. */
function outerName(name: string): void {
    assertSqlName(name, "outer name");
    if (name === "ps" || name === "pa") throw new Error(`"${name}" clashes with an alias the playable pieces use inside`);
}

/** PLAYABLE_ALBUM_WHERE for raw SQL, given the name the query uses for the album (an alias such as `al`). */
export function albumHasPlayableSongSql(album: string): Prisma.Sql {
    outerName(album);
    return albumSql(album);
}

function albumSql(album: string): Prisma.Sql {
    return Prisma.sql`EXISTS (SELECT 1 FROM "Track" ps WHERE ps."albumId" = "${Prisma.raw(album)}".id AND ${playableSongSql("ps", album)})`;
}

/** An artist with a PLAYABLE_ALBUM_WHERE album, for raw SQL, given the name the query uses for the artist. */
export function artistHasPlayableSongSql(artist: string): Prisma.Sql {
    outerName(artist);
    return Prisma.sql`EXISTS (SELECT 1 FROM "Album" pa WHERE pa."artistId" = "${Prisma.raw(artist)}".id AND ${albumSql("pa")})`;
}

export type CollectionFilter = "owned" | "discovery" | "all";

/** The collection's "show" choice from a query value: anything unknown is the library. */
export function collectionFilter(value: unknown): CollectionFilter {
    return value === "discovery" || value === "all" ? value : "owned";
}

/**
 * The rgMbids of this listener's current Discover albums (Discover Weekly suggestions not yet liked, rejected or
 * cleared). Another listener's suggestions are theirs.
 */
export async function yourDiscoverRgMbids(userId: string): Promise<string[]> {
    const rows = await prisma.discoveryAlbum.findMany({
        where: { userId, status: "ACTIVE" },
        select: { rgMbid: true },
        distinct: ["rgMbid"],
    });
    return rows.map((r) => r.rgMbid);
}

/**
 * The albums the collection's "show" choice lists: "owned" the library's albums with a playable song (Discover albums
 * only after a like moves them there), "discovery" this listener's own current Discover albums, "all" both.
 */
export function collectionAlbumWhere(filter: CollectionFilter, yourDiscover: string[]): Prisma.AlbumWhereInput {
    const discover: Prisma.AlbumWhereInput = { location: "DISCOVER", rgMbid: { in: yourDiscover } };
    if (filter === "owned") return PLAYABLE_ALBUM_WHERE;
    if (filter === "discovery") return discover;
    return { OR: [PLAYABLE_ALBUM_WHERE, discover] };
}
