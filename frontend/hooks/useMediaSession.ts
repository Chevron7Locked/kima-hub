import { useEffect, useCallback, useRef } from "react";
import { useAudio } from "@/lib/audio-context";
import { audioEngine } from "@/lib/audio-engine";
import { api } from "@/lib/api";

/**
 * Media Session API integration for OS-level media controls
 *
 * playbackState is driven by audio engine events (the source of truth),
 * not React state, to avoid async timing issues that cause inverted
 * lock screen controls on iOS.
 */
export function useMediaSession() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        setIsPlaying,
        next,
        previous,
        seek,
        currentTime,
    } = useAudio();

    const currentTimeRef = useRef(currentTime);
    const nextRef = useRef(next);
    const previousRef = useRef(previous);
    const seekRef = useRef(seek);
    const setIsPlayingRef = useRef(setIsPlaying);
    const playbackTypeRef = useRef(playbackType);
    const currentTrackRef = useRef(currentTrack);
    const currentAudiobookRef = useRef(currentAudiobook);
    const currentPodcastRef = useRef(currentPodcast);

    useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
    useEffect(() => { nextRef.current = next; }, [next]);
    useEffect(() => { previousRef.current = previous; }, [previous]);
    useEffect(() => { seekRef.current = seek; }, [seek]);
    useEffect(() => { setIsPlayingRef.current = setIsPlaying; }, [setIsPlaying]);
    useEffect(() => { playbackTypeRef.current = playbackType; }, [playbackType]);
    useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
    useEffect(() => { currentAudiobookRef.current = currentAudiobook; }, [currentAudiobook]);
    useEffect(() => { currentPodcastRef.current = currentPodcast; }, [currentPodcast]);

    // Track if this device has initiated playback locally
    const hasPlayedLocallyRef = useRef(false);
    // Track if action handlers have been registered (one-time gate)
    const handlersRegisteredRef = useRef(false);
    // Track pre-interruption state for auto-resume after phone calls/Siri
    const wasPlayingBeforeInterruptionRef = useRef(false);
    const isPlayingRef = useRef(isPlaying);
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

    useEffect(() => {
        if (isPlaying) {
            hasPlayedLocallyRef.current = true;
        }
    }, [isPlaying]);

    useEffect(() => {
        if (!currentTrack && !currentAudiobook && !currentPodcast) {
            hasPlayedLocallyRef.current = false;
            handlersRegisteredRef.current = false;
            if ("mediaSession" in navigator) {
                navigator.mediaSession.playbackState = "none";
            }
        }
    }, [currentTrack, currentAudiobook, currentPodcast]);

    const getAbsoluteUrl = useCallback((url: string): string => {
        if (!url) return "";
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return url;
        }
        if (typeof window !== "undefined") {
            return `${window.location.origin}${url}`;
        }
        return url;
    }, []);

    // Drive playbackState from audio engine events, not React state.
    // This fires synchronously when the audio element actually starts/stops,
    // eliminating the async gap that caused inverted lock screen controls.
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;

        const handlePlay = () => {
            if (hasPlayedLocallyRef.current) {
                navigator.mediaSession.playbackState = "playing";
            }
        };

        const handlePause = () => {
            if (hasPlayedLocallyRef.current) {
                navigator.mediaSession.playbackState = "paused";
            }
        };

        audioEngine.on("play", handlePlay);
        audioEngine.on("pause", handlePause);
        audioEngine.on("ended", handlePause);
        audioEngine.on("error", handlePause);

        return () => {
            audioEngine.off("play", handlePlay);
            audioEngine.off("pause", handlePause);
            audioEngine.off("ended", handlePause);
            audioEngine.off("error", handlePause);
        };
    }, []);

    // Metadata updates -- still driven by React state since metadata
    // changes are infrequent and not timing-sensitive like playbackState.
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;

        if (!hasPlayedLocallyRef.current) {
            navigator.mediaSession.metadata = null;
            return;
        }

        const fallbackArtwork = [
            { src: getAbsoluteUrl("/assets/icons/icon-512.webp"), sizes: "512x512", type: "image/webp" },
        ];

        if (playbackType === "track" && currentTrack) {
            const coverUrl = currentTrack.album?.coverArt
                ? getAbsoluteUrl(api.getCoverArtUrl(currentTrack.album.coverArt, 512))
                : undefined;

            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentTrack.title,
                artist: currentTrack.artist?.name || "Unknown Artist",
                album: currentTrack.album?.title || "Unknown Album",
                artwork: coverUrl
                    ? [
                          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
                          { src: coverUrl, sizes: "128x128", type: "image/jpeg" },
                          { src: coverUrl, sizes: "192x192", type: "image/jpeg" },
                          { src: coverUrl, sizes: "256x256", type: "image/jpeg" },
                          { src: coverUrl, sizes: "384x384", type: "image/jpeg" },
                          { src: coverUrl, sizes: "512x512", type: "image/jpeg" },
                      ]
                    : fallbackArtwork,
            });
        } else if (playbackType === "audiobook" && currentAudiobook) {
            const coverUrl = currentAudiobook.coverUrl
                ? getAbsoluteUrl(api.getCoverArtUrl(currentAudiobook.coverUrl, 512))
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
                          { src: coverUrl, sizes: "128x128", type: "image/jpeg" },
                          { src: coverUrl, sizes: "192x192", type: "image/jpeg" },
                          { src: coverUrl, sizes: "256x256", type: "image/jpeg" },
                          { src: coverUrl, sizes: "384x384", type: "image/jpeg" },
                          { src: coverUrl, sizes: "512x512", type: "image/jpeg" },
                      ]
                    : fallbackArtwork,
            });
        } else if (playbackType === "podcast" && currentPodcast) {
            const coverUrl = currentPodcast.coverUrl
                ? getAbsoluteUrl(api.getCoverArtUrl(currentPodcast.coverUrl, 512))
                : undefined;

            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentPodcast.title,
                artist: currentPodcast.podcastTitle,
                album: "Podcast",
                artwork: coverUrl
                    ? [
                          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
                          { src: coverUrl, sizes: "128x128", type: "image/jpeg" },
                          { src: coverUrl, sizes: "192x192", type: "image/jpeg" },
                          { src: coverUrl, sizes: "256x256", type: "image/jpeg" },
                          { src: coverUrl, sizes: "384x384", type: "image/jpeg" },
                          { src: coverUrl, sizes: "512x512", type: "image/jpeg" },
                      ]
                    : fallbackArtwork,
            });
        } else {
            navigator.mediaSession.metadata = null;
        }
    }, [
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        getAbsoluteUrl,
    ]);

    // Register action handlers once when first playback occurs. Uses refs
    // so handlers always access current values without re-registration.
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        if (!hasPlayedLocallyRef.current) return;
        if (handlersRegisteredRef.current) return;
        handlersRegisteredRef.current = true;

        // Play handler: call audioEngine directly to preserve iOS user gesture
        // context, then sync React state from the audio element event.
        navigator.mediaSession.setActionHandler("play", () => {
            wasPlayingBeforeInterruptionRef.current = false;
            audioEngine.tryResume().then((started) => {
                if (started) {
                    setIsPlayingRef.current(true);
                }
            });
        });

        navigator.mediaSession.setActionHandler("pause", () => {
            wasPlayingBeforeInterruptionRef.current = isPlayingRef.current;
            audioEngine.pause();
            setIsPlayingRef.current(false);
        });

        navigator.mediaSession.setActionHandler("previoustrack", () => {
            if (playbackTypeRef.current === "track") {
                previousRef.current();
            } else {
                seekRef.current(Math.max(currentTimeRef.current - 30, 0));
            }
        });

        navigator.mediaSession.setActionHandler("nexttrack", () => {
            if (playbackTypeRef.current === "track") {
                nextRef.current();
            } else {
                const duration =
                    currentAudiobookRef.current?.duration ||
                    currentPodcastRef.current?.duration || 0;
                seekRef.current(Math.min(currentTimeRef.current + 30, duration));
            }
        });

        try {
            navigator.mediaSession.setActionHandler("seekbackward", (details) => {
                const skipTime = details.seekOffset || 10;
                seekRef.current(Math.max(currentTimeRef.current - skipTime, 0));
            });

            navigator.mediaSession.setActionHandler("seekforward", (details) => {
                const skipTime = details.seekOffset || 10;
                const duration =
                    currentTrackRef.current?.duration ||
                    currentAudiobookRef.current?.duration ||
                    currentPodcastRef.current?.duration || 0;
                seekRef.current(Math.min(currentTimeRef.current + skipTime, duration));
            });

            navigator.mediaSession.setActionHandler("seekto", (details) => {
                if (details.seekTime !== undefined) {
                    seekRef.current(details.seekTime);
                }
            });
        } catch {
            // Seek actions not supported on this platform
        }

    }, [isPlaying]);

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
                console.warn("[MediaSession] Failed to set position state:", error);
            }
        }
    }, [currentTime, currentTrack, currentAudiobook, currentPodcast]);

    // Re-sync playbackState on foreground restore.
    // Uses audioEngine.isPlaying() (ground truth) instead of React ref.
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;

        const handleVisibilityChange = () => {
            if (!document.hidden && hasPlayedLocallyRef.current) {
                navigator.mediaSession.playbackState = audioEngine.isPlaying()
                    ? "playing"
                    : "paused";

                // If playback was interrupted (phone call, Siri, etc.), try to resume
                if (wasPlayingBeforeInterruptionRef.current && !audioEngine.isPlaying()) {
                    wasPlayingBeforeInterruptionRef.current = false;
                    audioEngine.tryResume().then((started) => {
                        if (started) {
                            setIsPlayingRef.current(true);
                            navigator.mediaSession.playbackState = "playing";
                        }
                    });
                }
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () =>
            document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, []);
}
