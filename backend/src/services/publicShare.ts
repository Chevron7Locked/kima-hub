// What a stranger holding a share link can see. Every field is named here; a field added to the schema later
// stays private until it is added to a list below.

import { prisma } from "../utils/db";

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

const findTrack = (id: string) => prisma.track.findUnique({ where: { id }, select: trackFields });

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

export async function loadPublicTrack(id: string) {
    const track = await findTrack(id);
    return track ? publicTrack(track) : null;
}

export async function loadPublicAlbum(id: string) {
    const album = await prisma.album.findUnique({
        where: { id },
        select: {
            id: true,
            title: true,
            displayTitle: true,
            coverUrl: true,
            artist: { select: { name: true, displayName: true } },
            tracks: {
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
            items: { select: { id: true, sort: true, track: { select: trackFields } }, orderBy: { rank: "asc" } },
        },
    });
    if (!playlist) return null;
    return {
        id: playlist.id,
        name: playlist.name,
        items: playlist.items.map((item) => ({ id: item.id, sort: item.sort, track: publicTrack(item.track) })),
    };
}
