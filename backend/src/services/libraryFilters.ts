/**
 * Library-scope filters. DISCOVER albums are suggestions, not owned, so a query
 * limited to owned content spreads one of these into its `where`.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";

/** `Album.location` for owned albums. */
export const LIBRARY_LOCATION = "LIBRARY";

/** Spread into an `Album` where-clause to scope it to owned-library albums. */
export const LIBRARY_ALBUM_WHERE: Prisma.AlbumWhereInput = {
    location: LIBRARY_LOCATION,
};

/** Spread into a `Track` where-clause (via the album relation) to scope it to owned-library tracks. */
export const LIBRARY_TRACK_WHERE: Prisma.TrackWhereInput = {
    album: { location: LIBRARY_LOCATION },
};

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
 * The albums the collection's "show" choice lists: "owned" the library (Discover albums only after a like moves them
 * there), "discovery" this listener's own current Discover albums, "all" both.
 */
export function collectionAlbumWhere(filter: CollectionFilter, yourDiscover: string[]): Prisma.AlbumWhereInput {
    const discover: Prisma.AlbumWhereInput = { location: "DISCOVER", rgMbid: { in: yourDiscover } };
    if (filter === "owned") return LIBRARY_ALBUM_WHERE;
    if (filter === "discovery") return discover;
    return { OR: [LIBRARY_ALBUM_WHERE, discover] };
}
