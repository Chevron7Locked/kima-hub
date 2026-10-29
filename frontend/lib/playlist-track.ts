import type { Track } from "./audio-state-context";

/** A song as the playlist endpoints send it; older rows can lack an album or artist. */
export interface PlaylistTrack {
    id: string;
    title: string;
    displayTitle?: string | null;
    duration: number;
    album?: { id?: string; title?: string; coverArt?: string; artist?: { id?: string; name?: string } };
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
