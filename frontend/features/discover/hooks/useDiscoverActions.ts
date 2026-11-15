import { useCallback } from "react";
import { useAudio } from "@/lib/audio-context";
import { notify } from "@/lib/notify";
import { api } from "@/lib/api";
import { queueSource } from "@/lib/queue-source";
import { DiscoverTrack, DiscoverPlaylist } from "../types";

export function useDiscoverActions(
    playlist: DiscoverPlaylist | null,
    onGenerationComplete?: () => void,
    isGenerating?: boolean,
    refreshBatchStatus?: () => Promise<unknown>,
    setPendingGeneration?: (pending: boolean) => void,
    markGenerationStart?: () => void,
    updateTrackLiked?: (albumId: string, isLiked: boolean) => void
) {
    const { playTracks } = useAudio();

    const handleGenerate = useCallback(async () => {
        if (isGenerating) {
            return;
        }

        // Set optimistic state immediately to prevent double-clicks
        setPendingGeneration?.(true);
        markGenerationStart?.();

        try {
            await api.generateDiscoverWeekly();

            // Immediately refresh batch status to start polling
            if (refreshBatchStatus) {
                await refreshBatchStatus();
            }
        } catch (error: unknown) {
            console.error("Generation failed:", error);
            setPendingGeneration?.(false);
            const err = error as Error & { status?: number };
            if (err.status === 409) {
                notify.info("A Discover playlist is already being generated");
                // Refresh status in case UI is out of sync
                if (refreshBatchStatus) {
                    await refreshBatchStatus();
                }
            } else if (err.status === 503) {
                // The server could not take, or lost, its lock before queuing: nothing was queued, so asking again is safe.
                notify.error("Failed to generate Discover playlist", { message: "try again in a moment" });
            } else {
                notify.error("Failed to generate Discover playlist", { message: err.message || undefined });
            }
        }
    }, [isGenerating, refreshBatchStatus, setPendingGeneration, markGenerationStart]);

    const handleLike = useCallback(
        async (track: DiscoverTrack) => {
            const newLikedState = !track.isLiked;
            
            // Optimistically update UI immediately
            updateTrackLiked?.(track.albumId, newLikedState);
            
            try {
                if (track.isLiked) {
                    await api.unlikeDiscoverAlbum(track.albumId);
                } else {
                    await api.likeDiscoverAlbum(track.albumId);
                }

                // Reload to sync with server state
                onGenerationComplete?.();
            } catch (error: unknown) {
                console.error("Like failed:", error);
                // Revert optimistic update on error
                updateTrackLiked?.(track.albumId, track.isLiked);
                notify.error("Failed to update Discover album", { message: error instanceof Error ? error.message : undefined });
            }
        },
        [onGenerationComplete, updateTrackLiked]
    );

    const formatPlaylistTracks = useCallback(() => {
        if (!playlist || playlist.tracks.length === 0) return null;
        return playlist.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            artist: { name: track.artist },
            album: {
                id: track.albumId,
                title: track.album,
                coverArt: track.coverUrl || undefined,
            },
            duration: track.duration || 0,
        }));
    }, [playlist]);

    const handlePlayPlaylist = useCallback(() => {
        const formattedTracks = formatPlaylistTracks();
        if (!formattedTracks) return;
        playTracks(formattedTracks, 0, { source: queueSource.discover });
    }, [formatPlaylistTracks, playTracks]);

    const handlePlayTrack = useCallback(
        (index: number) => {
            const formattedTracks = formatPlaylistTracks();
            if (!formattedTracks) return;
            playTracks(formattedTracks, index, { source: queueSource.discover });
        },
        [formatPlaylistTracks, playTracks]
    );

    return {
        handleGenerate,
        handleLike,
        handlePlayPlaylist,
        handlePlayTrack,
    };
}
