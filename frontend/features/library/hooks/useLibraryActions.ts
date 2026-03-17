import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { queryKeys } from "@/hooks/useQueries";
import { Track } from "../types";

// Helper to convert library Track to audio context Track format
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
    const queryClient = useQueryClient();

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
        try {
            addToQueue(formatTrackForAudio(track));
        } catch (error) {
            console.error("Error adding track to queue:", error);
        }
    }, [addToQueue]);

    const addTrackToPlaylist = useCallback(async (playlistId: string, trackId: string) => {
        try {
            await api.addTrackToPlaylist(playlistId, trackId);
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
            queryClient.invalidateQueries({ queryKey: queryKeys.playlist(playlistId) });
        } catch (error) {
            console.error("Error adding track to playlist:", error);
        }
    }, [queryClient]);

    const deleteTrack = useCallback(async (id: string): Promise<void> => {
        try {
            await api.deleteTrack(id);
        } catch (error) {
            throw error;
        }
    }, []);

    const deleteAlbum = useCallback(async (id: string): Promise<void> => {
        try {
            await api.deleteAlbum(id);
        } catch (error) {
            throw error;
        }
    }, []);

    const deleteArtist = useCallback(async (id: string): Promise<void> => {
        try {
            await api.deleteArtist(id);
        } catch (error) {
            throw error;
        }
    }, []);

    return useMemo(() => ({
        playArtist,
        playAlbum,
        addTrackToQueue,
        addTrackToPlaylist,
        deleteTrack,
        deleteAlbum,
        deleteArtist,
    }), [
        playArtist,
        playAlbum,
        addTrackToQueue,
        addTrackToPlaylist,
        deleteTrack,
        deleteAlbum,
        deleteArtist,
    ]);
}
