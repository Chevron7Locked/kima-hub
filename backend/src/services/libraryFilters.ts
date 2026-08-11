/**
 * Canonical library-scope filters.
 *
 * Kima keeps a separate "DISCOVER"-location pile for suggested-but-not-owned
 * albums/tracks (see CLAUDE.md: "DISCOVER-location albums are excluded from
 * normal library views"). Any query that should only ever see content the
 * user actually owns must spread one of these into its `where` clause rather
 * than re-typing `location: "LIBRARY"` inline, so the invariant stays
 * enforced from a single place.
 */

import { Prisma } from "@prisma/client";

/**
 * The `Album.location` value meaning "the user owns this".
 *
 * Exported separately because one query cannot use the where-clauses below:
 * `shuffleTracks` draws random ids in raw SQL, where a Prisma filter object is
 * not available. That query interpolates THIS constant rather than repeating
 * the string, so a change here reaches the raw-SQL path too.
 */
export const LIBRARY_LOCATION = "LIBRARY";

/** Spread into an `Album` where-clause to scope it to owned-library albums. */
export const LIBRARY_ALBUM_WHERE: Prisma.AlbumWhereInput = {
    location: LIBRARY_LOCATION,
};

/** Spread into a `Track` where-clause (via the album relation) to scope it to owned-library tracks. */
export const LIBRARY_TRACK_WHERE: Prisma.TrackWhereInput = {
    album: { location: LIBRARY_LOCATION },
};
