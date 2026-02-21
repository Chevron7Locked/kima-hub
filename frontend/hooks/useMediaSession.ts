import { useEffect, useCallback, useRef } from "react";
import { useAudio } from "@/lib/audio-context";
import { api } from "@/lib/api";

/**
 * Media Session API integration for OS-level media controls
 *
 * Features:
 * - Lock screen controls (iOS/Android)
 * - Media keys (play/pause, next, previous)
 * - Now playing notification
 * - Album art display
 * - Seek controls (on supported platforms)
 */
export function useMediaSession() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        pause,
        resume,
        next,
        previous,
        seek,
        currentTime,
    } = useAudio();

    const currentTimeRef = useRef(currentTime);

    useEffect(() => {
        currentTimeRef.current = currentTime;
    }, [currentTime]);

    // Track if this device has initiated playback locally
    // Prevents cross-device media session interference from state sync
    const hasPlayedLocallyRef = useRef(false);

    // Set flag when playback starts on this device
    useEffect(() => {
        if (isPlaying) {
            hasPlayedLocallyRef.current = true;
        }
    }, [isPlaying]);

    // Reset flag when all media is cleared
    useEffect(() => {
        if (!currentTrack && !currentAudiobook && !currentPodcast) {
            hasPlayedLocallyRef.current = false;
        }
    }, [currentTrack, currentAudiobook, currentPodcast]);

    // Convert relative URLs to absolute (required for iOS)
    const getAbsoluteUrl = useCallback((url: string): string => {
        if (!url) return "";
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return url;
        }
        // Construct absolute URL
        if (typeof window !== "undefined") {
            return `${window.location.origin}${url}`;
        }
        return url;
    }, []);

    useEffect(() => {
        // Check if Media Session API is supported
        if (!("mediaSession" in navigator)) {
            console.warn("[MediaSession] Media Session API not supported");
            return;
        }

        // Only set metadata if this device has initiated playback
        // Prevents cross-device interference from state sync
        if (!hasPlayedLocallyRef.current) {
            navigator.mediaSession.metadata = null;
            return;
        }

        // Update metadata when track/audiobook/podcast changes
        const fallbackArtwork = [
            { src: getAbsoluteUrl("/assets/icons/icon-512.webp"), sizes: "512x512", type: "image/webp" },
        ];

        if (playbackType === "track" && currentTrack) {
            const coverUrl = currentTrack.album?.coverArt
                ? getAbsoluteUrl(
                      api.getCoverArtUrl(currentTrack.album.coverArt, 512)
                  )
                : undefined;

            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentTrack.title,
                artist: currentTrack.artist?.name || "Unknown Artist",
                album: currentTrack.album?.title || "Unknown Album",
                artwork: coverUrl
                    ? [
                          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
                          {
                              src: coverUrl,
                              sizes: "128x128",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "192x192",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "256x256",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "384x384",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "512x512",
                              type: "image/jpeg",
                          },
                      ]
                    : fallbackArtwork,
            });
        } else if (playbackType === "audiobook" && currentAudiobook) {
            const coverUrl = currentAudiobook.coverUrl
                ? getAbsoluteUrl(
                      api.getCoverArtUrl(currentAudiobook.coverUrl, 512)
                  )
                : undefined;

            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentAudiobook.title,
                artist: currentAudiobook.author,
                album: currentAudiobook.narrator
                    ? `Narrated by ${currentAudiobook.narrator}`
                    : "Audiobook",
                artwork: coverUrl
                    ? [
                          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
                          {
                              src: coverUrl,
                              sizes: "128x128",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "192x192",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "256x256",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "384x384",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "512x512",
                              type: "image/jpeg",
                          },
                      ]
                    : fallbackArtwork,
            });
        } else if (playbackType === "podcast" && currentPodcast) {
            const coverUrl = currentPodcast.coverUrl
                ? getAbsoluteUrl(
                      api.getCoverArtUrl(currentPodcast.coverUrl, 512)
                  )
                : undefined;

            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentPodcast.title,
                artist: currentPodcast.podcastTitle,
                album: "Podcast",
                artwork: coverUrl
                    ? [
                          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
                          {
                              src: coverUrl,
                              sizes: "128x128",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "192x192",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "256x256",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "384x384",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "512x512",
                              type: "image/jpeg",
                          },
                      ]
                    : fallbackArtwork,
            });
        } else {
            // Clear metadata when nothing is playing
            navigator.mediaSession.metadata = null;
        }

        // Update playback state
        navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    }, [
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        getAbsoluteUrl,
    ]);

    useEffect(() => {
        if (!("mediaSession" in navigator)) return;

        // Only register handlers if this device has initiated playback
        // Prevents cross-device interference from state sync
        if (!hasPlayedLocallyRef.current) {
            return;
        }

        // Register action handlers
        navigator.mediaSession.setActionHandler("play", () => {
            resume();
        });

        navigator.mediaSession.setActionHandler("pause", () => {
            pause();
        });

        navigator.mediaSession.setActionHandler("previoustrack", () => {
            if (playbackType === "track") {
                previous();
            } else {
                // For audiobooks/podcasts, seek backward 30s
                seek(Math.max(currentTimeRef.current - 30, 0));
            }
        });

        navigator.mediaSession.setActionHandler("nexttrack", () => {
            if (playbackType === "track") {
                next();
            } else {
                // For audiobooks/podcasts, seek forward 30s
                const duration =
                    currentAudiobook?.duration || currentPodcast?.duration || 0;
                seek(Math.min(currentTimeRef.current + 30, duration));
            }
        });

        // Seek controls (may not be supported on all platforms)
        try {
            navigator.mediaSession.setActionHandler(
                "seekbackward",
                (details) => {
                    const skipTime = details.seekOffset || 10;
                    seek(Math.max(currentTimeRef.current - skipTime, 0));
                }
            );

            navigator.mediaSession.setActionHandler(
                "seekforward",
                (details) => {
                    const skipTime = details.seekOffset || 10;
                    const duration =
                        currentTrack?.duration ||
                        currentAudiobook?.duration ||
                        currentPodcast?.duration ||
                        0;
                    seek(Math.min(currentTimeRef.current + skipTime, duration));
                }
            );

            navigator.mediaSession.setActionHandler("seekto", (details) => {
                if (details.seekTime !== undefined) {
                    seek(details.seekTime);
                }
            });
        } catch {
            // Seek actions not supported on this platform
        }

        // Cleanup
        return () => {
            if ("mediaSession" in navigator) {
                navigator.mediaSession.setActionHandler("play", null);
                navigator.mediaSession.setActionHandler("pause", null);
                navigator.mediaSession.setActionHandler("previoustrack", null);
                navigator.mediaSession.setActionHandler("nexttrack", null);
                try {
                    navigator.mediaSession.setActionHandler(
                        "seekbackward",
                        null
                    );
                    navigator.mediaSession.setActionHandler(
                        "seekforward",
                        null
                    );
                    navigator.mediaSession.setActionHandler("seekto", null);
                } catch {
                    // Ignore cleanup errors
                }
            }
        };
    }, [
        pause,
        resume,
        next,
        previous,
        seek,
        playbackType,
        currentTrack,
        currentAudiobook,
        currentPodcast,
    ]);

    // Update position state for scrubbing on lock screen
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        if (!("setPositionState" in navigator.mediaSession)) return;

        const duration =
            currentTrack?.duration ||
            currentAudiobook?.duration ||
            currentPodcast?.duration;

        if (duration && currentTime !== undefined) {
            try {
                navigator.mediaSession.setPositionState({
                    duration,
                    playbackRate: 1,
                    position: Math.min(currentTime, duration),
                });
            } catch (error) {
                // Some browsers may not support position state
                console.warn(
                    "[MediaSession] Failed to set position state:",
                    error
                );
            }
        }
    }, [currentTime, currentTrack, currentAudiobook, currentPodcast]);
}
