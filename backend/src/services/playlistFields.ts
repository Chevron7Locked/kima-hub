import { Prisma } from "@prisma/client";

/**
 * The playlist fields any answer carries, named one by one: a playlist is read by people who do not own it, so a row
 * with fields taken away would hand out whatever column is added next. Not here on purpose: the owner's id, the mix and
 * Spotify links, the create key.
 */
export const playlistFields = {
    id: true,
    name: true,
    isPublic: true,
    reverseOrder: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.PlaylistSelect;

/** A playlist read with `playlistFields`, written out field by field, for answers that add their own fields beside it. */
export function namedFields(playlist: Prisma.PlaylistGetPayload<{ select: typeof playlistFields }>) {
    return {
        id: playlist.id,
        name: playlist.name,
        isPublic: playlist.isPublic,
        reverseOrder: playlist.reverseOrder,
        createdAt: playlist.createdAt,
        updatedAt: playlist.updatedAt,
    };
}

/**
 * What a playlist's song rows read from the database: the fields the web player and the iOS app use to list and play
 * them (named in the answer one by one). Not here on purpose: the file path and its size, analysis, the artist's mbid,
 * the playlist id and the item's rank.
 */
export const playlistItemFields = {
    id: true,
    sort: true,
    rank: true,
    trackId: true,
    track: {
        select: {
            id: true,
            title: true,
            displayTitle: true,
            duration: true,
            album: {
                select: {
                    id: true,
                    title: true,
                    coverUrl: true,
                    artist: { select: { id: true, name: true } },
                },
            },
        },
    },
} satisfies Prisma.PlaylistItemSelect;
