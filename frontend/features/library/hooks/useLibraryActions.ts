import { useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAddToPlaylistMutation } from "@/hooks/useQueries";
import { Track } from "../types";

const formatTrackForAudio = (track: Track) => ({
    id: track.id,
    title: track.title,
    duration: track.duration,
    artist: {
        id: track.album?.artist?.id,
        name: track.album?.artist?.name || "Unknown Artist",
    },
    album: {
        id: track.album?.id,
        title: track.album?.title || "Unknown Album",
        coverArt: track.album?.coverArt,
    },
});

export function useLibraryActions() {
    const { playTracks, addToQueue } = useAudioControls();
    const { mutateAsync: addToPlaylist } = useAddToPlaylistMutation();

    const playArtist = useCallback(async (artistId: string) => {
        try {
            const albumsData = await api.getAlbums({ artistId });
            if (!albumsData.albums || albumsData.albums.length === 0) {
                return;
            }

            const firstAlbum = await api.getAlbum(albumsData.albums[0].id);
            if (
                !firstAlbum ||
                !firstAlbum.tracks ||
                firstAlbum.tracks.length === 0
            ) {
                return;
            }

            const tracksWithAlbum = firstAlbum.tracks.map((track: Record<string, unknown>) => ({
                ...track,
                album: {
                    id: firstAlbum.id,
                    title: firstAlbum.title,
                    coverArt: firstAlbum.coverArt || firstAlbum.coverUrl,
                },
                artist: {
                    id: firstAlbum.artist?.id,
                    name: firstAlbum.artist?.name,
                },
            }));

            playTracks(tracksWithAlbum, 0);
        } catch (error) {
            console.error("Error playing artist:", error);
        }
    }, [playTracks]);

    const playAlbum = useCallback(async (albumId: string) => {
        try {
            const album = await api.getAlbum(albumId);
            if (!album || !album.tracks || album.tracks.length === 0) {
                return;
            }

            const tracksWithAlbum = album.tracks.map((track: Record<string, unknown>) => ({
                ...track,
                album: {
                    id: album.id,
                    title: album.title,
                    coverArt: album.coverArt || album.coverUrl,
                },
                artist: {
                    id: album.artist?.id,
                    name: album.artist?.name,
                },
            }));

            playTracks(tracksWithAlbum, 0);
        } catch (error) {
            console.error("Error playing album:", error);
        }
    }, [playTracks]);

    const addTrackToQueue = useCallback((track: Track) => {
        addToQueue(formatTrackForAudio(track));
    }, [addToQueue]);

    const addTrackToPlaylist = useCallback(
        async (playlistId: string, trackId: string) => {
            // The shared mutation owns the request and the cache refresh;
            // it rejects on failure so the selector dialog stays open and
            // reports the error.
            await addToPlaylist({ playlistId, trackId });
        },
        [addToPlaylist],
    );

    return useMemo(() => ({
        playArtist,
        playAlbum,
        addTrackToQueue,
        addTrackToPlaylist,
    }), [
        playArtist,
        playAlbum,
        addTrackToQueue,
        addTrackToPlaylist,
    ]);
}
