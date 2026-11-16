/**
 * What a share holds: the one module that decides it.
 *
 * - `loadPublicShare`: the page a stranger holding the link sees. A public share is an explicit list of fields, every
 *   one named below; a field added to the schema later stays private until it is added to a list. It shows the title and
 *   artist name a person edited, and carries no username.
 * - `songOfShare`: the song a link plays (the share stream).
 * - `shareHoldsCover`: whether a link may show a stored cover (the share cover route).
 * - `songsOfShare`: the songs a link lists, for Subsonic's share entries.
 * - `shareTargetExists`: whether a song, album or playlist can be shared at all (creation).
 *
 * A share holds one song, one album or one playlist, and a stranger sees only playable songs of it: a song that is
 * missing, corrupt or on a Discover album is not there for them either, so a share of it answers as if its content were
 * gone. A playlist's songs follow its `rank`; an album's follow disc and track number. A share of a type this module
 * does not know holds nothing.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { PLAYABLE_ALBUM_WHERE } from "./libraryFilters";
import { coverAddressWhere } from "./imageStorage";

/** What a share is of: the `entityType` and `entityId` of its link. */
export interface ShareContent {
    entityType: string;
    entityId: string;
}

const ALBUM_SONG_ORDER = [{ discNumber: { sort: "asc", nulls: "first" } }, { trackNo: "asc" }] satisfies Prisma.TrackOrderByWithRelationInput[];

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

type AlbumTrackRow = Prisma.TrackGetPayload<{ select: typeof albumTrackFields }>;

function publicAlbumTrack(track: AlbumTrackRow) {
    return {
        id: track.id,
        title: track.displayTitle || track.title,
        duration: track.duration,
        trackNo: track.trackNo,
        discNumber: track.discNumber,
        discSubtitle: track.discSubtitle,
    };
}

function publicTrack(track: TrackRow) {
    return {
        ...publicAlbumTrack(track),
        album: {
            title: track.album.displayTitle || track.album.title,
            coverUrl: track.album.coverUrl,
            artist: { name: track.album.artist.displayName || track.album.artist.name },
        },
    };
}

async function loadPublicTrack(id: string) {
    const track = await findTrack(id);
    return track ? publicTrack(track) : null;
}

async function loadPublicAlbum(id: string) {
    const album = await prisma.album.findFirst({
        where: { id, ...PLAYABLE_ALBUM_WHERE },
        select: {
            id: true,
            title: true,
            displayTitle: true,
            coverUrl: true,
            artist: { select: { name: true, displayName: true } },
            tracks: { where: PLAYABLE_SONG, orderBy: ALBUM_SONG_ORDER, select: albumTrackFields },
        },
    });
    if (!album) return null;
    return {
        id: album.id,
        title: album.displayTitle || album.title,
        coverUrl: album.coverUrl,
        artist: { name: album.artist.displayName || album.artist.name },
        tracks: album.tracks.map(publicAlbumTrack),
    };
}

async function loadPublicPlaylist(id: string) {
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

/** The page of a share as a stranger sees it, or null when there is nothing left to show (the content is gone, nothing in it plays, or the type is unknown). */
export async function loadPublicShare({ entityType, entityId }: ShareContent): Promise<object | null> {
    if (entityType === "track") return loadPublicTrack(entityId);
    if (entityType === "album") return loadPublicAlbum(entityId);
    if (entityType === "playlist") return loadPublicPlaylist(entityId);
    return null;
}

/**
 * What a song must satisfy to be held by a share, as a `where` on Track: null when the share can never hold that song, `{}`
 * when the share is of the song itself, else the filter (the album, the playlist) the song has to match. Its keys stay clear
 * of those of the playable rule it is merged with.
 */
function holding({ entityType, entityId }: ShareContent, trackId: string): Prisma.TrackWhereInput | null {
    if (entityType === "track") return entityId === trackId ? {} : null;
    if (entityType === "album") return { albumId: entityId };
    if (entityType === "playlist") return { playlistItems: { some: { playlistId: entityId } } };
    return null;
}

/**
 * The song a share plays for this id: its file path when the share holds it and it is a playable song, "not-covered" when
 * the share does not hold it and "not-playable" when it holds it but it is missing, corrupt, Discover or has no file path.
 * One query answers a song that plays; the second only tells the two refusals apart.
 */
export async function songOfShare(share: ShareContent, trackId: string): Promise<{ filePath: string } | "not-covered" | "not-playable"> {
    const held = holding(share, trackId);
    if (held === null) return "not-covered";
    const song = await prisma.track.findFirst({ where: { id: trackId, ...held, ...PLAYABLE_SONG }, select: { filePath: true } });
    if (song?.filePath) return { filePath: song.filePath };
    // A share of the song itself holds it by id alone; any other share must hold it for the refusal to be "not-playable".
    if (share.entityType === "track") return "not-playable";
    const exists = await prisma.track.findFirst({ where: { id: trackId, ...held }, select: { id: true } });
    return exists ? "not-playable" : "not-covered";
}

/** Whether the stored cover at `relativePath` (under the covers folder, whatever its version) is the cover of an album the share holds: the song's album, the shared album, or the album of a playable song in the shared playlist. */
export async function shareHoldsCover({ entityType, entityId }: ShareContent, relativePath: string): Promise<boolean> {
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

/** The playable songs a share holds, in the share's order, with the relations in `include`: the song itself, an album in disc and track order, a playlist by rank. */
export async function songsOfShare<I extends Prisma.TrackInclude>(
    { entityType, entityId }: ShareContent,
    include: I,
): Promise<Prisma.TrackGetPayload<{ include: I }>[]> {
    if (entityType === "track") return prisma.track.findMany({ where: { id: entityId, ...PLAYABLE_SONG }, include });
    if (entityType === "album") {
        return prisma.track.findMany({ where: { albumId: entityId, ...PLAYABLE_SONG }, orderBy: ALBUM_SONG_ORDER, include });
    }
    if (entityType === "playlist") {
        const items = await prisma.playlistItem.findMany({
            where: { playlistId: entityId, track: PLAYABLE_SONG },
            orderBy: { rank: "asc" },
            include: { track: { include } },
        });
        return items.map((item) => item.track) as Prisma.TrackGetPayload<{ include: I }>[];
    }
    return [];
}

/** Whether a song, album or playlist can be shared: a song or album needs something to play, a playlist only has to exist. */
export async function shareTargetExists({ entityType, entityId }: ShareContent): Promise<boolean> {
    if (entityType === "track") return (await prisma.track.findFirst({ where: { id: entityId, ...PLAYABLE_SONG }, select: { id: true } })) !== null;
    if (entityType === "album") return (await prisma.album.findFirst({ where: { id: entityId, ...PLAYABLE_ALBUM_WHERE }, select: { id: true } })) !== null;
    if (entityType === "playlist") return (await prisma.playlist.findUnique({ where: { id: entityId }, select: { id: true } })) !== null;
    return false;
}
