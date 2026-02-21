import { useMemo } from "react";
import { useAudioState } from "@/lib/audio-context";
import { api } from "@/lib/api";

export interface MediaInfo {
    title: string;
    subtitle: string;
    coverUrl: string | null;
    albumLink: string | null;
    artistLink: string | null;
    mediaLink: string | null;
    hasMedia: boolean;
}

export function useMediaInfo(coverSize: number = 100): MediaInfo {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
    } = useAudioState();

    return useMemo(() => {
        const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

        if (playbackType === "track" && currentTrack) {
            const albumLink = currentTrack.album?.id
                ? `/album/${currentTrack.album.id}`
                : null;
            const artistLink = currentTrack.artist?.id
                ? `/artist/${currentTrack.artist.id}`
                : null;
            return {
                title: currentTrack.title,
                subtitle: currentTrack.artist?.name || "Unknown Artist",
                coverUrl: currentTrack.album?.coverArt
                    ? api.getCoverArtUrl(currentTrack.album.coverArt, coverSize)
                    : null,
                albumLink,
                artistLink,
                mediaLink: albumLink,
                hasMedia,
            };
        }

        if (playbackType === "audiobook" && currentAudiobook) {
            return {
                title: currentAudiobook.title,
                subtitle: currentAudiobook.author,
                coverUrl: currentAudiobook.coverUrl
                    ? api.getCoverArtUrl(currentAudiobook.coverUrl, coverSize)
                    : null,
                albumLink: null,
                artistLink: null,
                mediaLink: `/audiobooks/${currentAudiobook.id}`,
                hasMedia,
            };
        }

        if (playbackType === "podcast" && currentPodcast) {
            const podcastId = currentPodcast.id.split(":")[0];
            return {
                title: currentPodcast.title,
                subtitle: currentPodcast.podcastTitle,
                coverUrl: currentPodcast.coverUrl
                    ? api.getCoverArtUrl(currentPodcast.coverUrl, coverSize)
                    : null,
                albumLink: null,
                artistLink: null,
                mediaLink: `/podcasts/${podcastId}`,
                hasMedia,
            };
        }

        return {
            title: "Not Playing",
            subtitle: "Select something to play",
            coverUrl: null,
            albumLink: null,
            artistLink: null,
            mediaLink: null,
            hasMedia,
        };
    }, [currentTrack, currentAudiobook, currentPodcast, playbackType, coverSize]);
}
