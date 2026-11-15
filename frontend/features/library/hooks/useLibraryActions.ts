import { useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { queueSource } from "@/lib/queue-source";
import { Track } from "../types";

const formatTrackForAudio = (track: Track) => ({
    id: track.id,
    title: track.title,
    displayTitle: track.displayTitle,
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

            playTracks(tracksWithAlbum, 0, { source: queueSource.album(album.id) });
        } catch (error) {
            console.error("Error playing album:", error);
        }
    }, [playTracks]);

    const addTrackToQueue = useCallback((track: Track) => {
        addToQueue(formatTrackForAudio(track));
    }, [addToQueue]);

    return useMemo(() => ({
        playArtist,
        playAlbum,
        addTrackToQueue,
    }), [
        playArtist,
        playAlbum,
        addTrackToQueue,
    ]);
}
