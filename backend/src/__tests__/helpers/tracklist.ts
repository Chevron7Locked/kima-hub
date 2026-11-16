import type { SpotifyTrack } from "../../services/spotify";
import type { Tracklist } from "../../services/playlistImport/types";

/** A listed song as a source wrote it; what a test leaves out is the plain default. */
export function listedSong(song: Partial<SpotifyTrack> & { title: string; artist: string }): SpotifyTrack {
    return {
        spotifyId: song.spotifyId ?? "t1",
        artistId: "",
        album: "Unknown Album",
        albumId: "",
        isrc: null,
        durationMs: 0,
        trackNumber: 1,
        previewUrl: null,
        coverUrl: null,
        ...song,
    };
}

/** What reading a playlist gives, for a test that starts at matching. */
export function tracklistOf(songs: Array<Partial<SpotifyTrack> & { title: string; artist: string }>, source = "Deezer"): Tracklist {
    const tracks = songs.map((song, at) => listedSong({ spotifyId: `t${at + 1}`, trackNumber: at + 1, ...song }));
    return { tracks, playlist: { id: "d", name: "d", description: null, owner: "o", imageUrl: null, trackCount: tracks.length }, source };
}
