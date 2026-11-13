import type { Track } from "./audio-state-context";

/** A song as the playlist endpoints send it; older rows can lack an album or artist. */
export interface PlaylistTrack {
    id: string;
    title: string;
    displayTitle?: string | null;
    duration: number;
    album?: { id?: string; title?: string; coverArt?: string; artist?: { id?: string; name?: string } };
}

/**
 * One song of a playlist as the server lists it. `unavailable` marks a song that stopped playing (its file is
 * missing or unreadable, or its album left the library): the playlist still lists it, and nothing plays it.
 */
export interface PlaylistEntry {
    id: string;
    track: PlaylistTrack;
    unavailable?: boolean;
}

/**
 * The queue to play from a listed playlist: its playable songs in order, skipping the unavailable ones. `index` is a
 * place in the whole list; `start` is that song's place in the queue. Null when there is nothing to play: no
 * playable song, or the song asked for is unavailable.
 */
export function playablePlaylist(
    items: PlaylistEntry[],
    index = 0,
): { tracks: Track[]; start: number } | null {
    if (items[index]?.unavailable) return null;
    const tracks = items.filter((item) => !item.unavailable).map((item) => playlistTrackToAudio(item.track));
    if (tracks.length === 0) return null;
    const start = items.slice(0, index).filter((item) => !item.unavailable).length;
    return { tracks, start };
}

/** A playlist's song as the player takes it. */
export function playlistTrackToAudio(track: PlaylistTrack): Track {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        artist: { name: track.album?.artist?.name || "Unknown", id: track.album?.artist?.id },
        album: { title: track.album?.title || "Unknown", coverArt: track.album?.coverArt, id: track.album?.id },
        duration: track.duration,
    };
}
