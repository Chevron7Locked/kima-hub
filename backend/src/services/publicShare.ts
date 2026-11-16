// What a stranger holding a share link can see. Every field is named here; a field added to the schema later
// stays private until it is added to a list below. A stranger sees only playable songs: one that is missing, corrupt
// or on a Discover album is not there for them either, so a share of it answers as if its content were gone.

import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { PLAYABLE_ALBUM_WHERE } from "./libraryFilters";
import { coverAddressWhere } from "./imageStorage";

const albumTrackFields = {
    id: true,
    title: true,
    displayTitle: true,
    duration: true,
    trackNo: true,
    discNumber: true,
    discSubtitle: true,
} as const;

const trackFields = {
    ...albumTrackFields,
    album: {
        select: {
            title: true,
            displayTitle: true,
            coverUrl: true,
            artist: { select: { name: true, displayName: true } },
        },
    },
} as const;

type TrackRow = NonNullable<Awaited<ReturnType<typeof findTrack>>>;

const findTrack = (id: string) => prisma.track.findFirst({ where: { id, ...PLAYABLE_SONG }, select: trackFields });

function publicTrack(track: TrackRow) {
    return {
        id: track.id,
        title: track.displayTitle || track.title,
        duration: track.duration,
        trackNo: track.trackNo,
        discNumber: track.discNumber,
        discSubtitle: track.discSubtitle,
        album: {
            title: track.album.displayTitle || track.album.title,
            coverUrl: track.album.coverUrl,
            artist: { name: track.album.artist.displayName || track.album.artist.name },
        },
    };
}

/** Whether the stored cover at `relativePath` (under the covers folder, whatever its version) is the cover of an album the share holds: the song's album, the shared album, or the album of a playable song in the shared playlist. */
export async function shareHoldsCover(share: { entityType: string; entityId: string }, relativePath: string): Promise<boolean> {
    const { entityType, entityId } = share;
    const holds: Prisma.AlbumWhereInput | null =
        entityType === "track" ? { tracks: { some: { id: entityId, ...PLAYABLE_SONG } } }
        : entityType === "album" ? { id: entityId, ...PLAYABLE_ALBUM_WHERE }
        : entityType === "playlist" ? { tracks: { some: { ...PLAYABLE_SONG, playlistItems: { some: { playlistId: entityId } } } } }
        : null;
    if (!holds) return false;
    // A page loaded before the cover was stored again still asks by the old version.
    const album = await prisma.album.findFirst({ where: { AND: [coverAddressWhere("coverUrl", relativePath), holds] }, select: { id: true } });
    return album !== null;
}

export async function loadPublicTrack(id: string) {
    const track = await findTrack(id);
    return track ? publicTrack(track) : null;
}

export async function loadPublicAlbum(id: string) {
    const album = await prisma.album.findFirst({
        where: { id, ...PLAYABLE_ALBUM_WHERE },
        select: {
            id: true,
            title: true,
            displayTitle: true,
            coverUrl: true,
            artist: { select: { name: true, displayName: true } },
            tracks: {
                where: PLAYABLE_SONG,
                orderBy: [{ discNumber: { sort: "asc", nulls: "first" } }, { trackNo: "asc" }],
                select: albumTrackFields,
            },
        },
    });
    if (!album) return null;
    return {
        id: album.id,
        title: album.displayTitle || album.title,
        coverUrl: album.coverUrl,
        artist: { name: album.artist.displayName || album.artist.name },
        tracks: album.tracks.map((t) => ({
            id: t.id,
            title: t.displayTitle || t.title,
            duration: t.duration,
            trackNo: t.trackNo,
            discNumber: t.discNumber,
            discSubtitle: t.discSubtitle,
        })),
    };
}

export async function loadPublicPlaylist(id: string) {
    const playlist = await prisma.playlist.findUnique({
        where: { id },
        select: {
            id: true,
            name: true,
            items: {
                where: { track: PLAYABLE_SONG },
                select: { id: true, sort: true, track: { select: trackFields } },
                orderBy: { rank: "asc" },
            },
        },
    });
    if (!playlist) return null;
    return {
        id: playlist.id,
        name: playlist.name,
        items: playlist.items.map((item) => ({ id: item.id, sort: item.sort, track: publicTrack(item.track) })),
    };
}
