import { useEffect, useCallback, useRef } from "react";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioController } from "@/lib/audio-controller-context";
import { api } from "@/lib/api";

export function useMediaSession() {
    const controller = useAudioController();
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
    } = useAudioState();
    const { currentTime } = useAudioPlayback();
    const { next, previous, seek } = useAudioControls();

    const currentTimeRef = useRef(currentTime);
    const playbackTypeRef = useRef(playbackType);
    const nextRef = useRef(next);
    const previousRef = useRef(previous);
    const seekRef = useRef(seek);
    const lastPositionUpdateRef = useRef(0);

    useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
    useEffect(() => { playbackTypeRef.current = playbackType; }, [playbackType]);
    useEffect(() => { nextRef.current = next; }, [next]);
    useEffect(() => { previousRef.current = previous; }, [previous]);
    useEffect(() => { seekRef.current = seek; }, [seek]);

    // Sync playbackState from controller events (single source of truth)
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        if (!controller) return;

        const onPlay = () => {
            navigator.mediaSession.playbackState = "playing";
            lastPositionUpdateRef.current = 0;
        };
        const onPause = () => { navigator.mediaSession.playbackState = "paused"; };

        controller.on("play", onPlay);
        controller.on("pause", onPause);
        controller.on("ended", onPause);
        controller.on("error", onPause);

        return () => {
            controller.off("play", onPlay);
            controller.off("pause", onPause);
            controller.off("ended", onPause);
            controller.off("error", onPause);
        };
    }, [controller]);

    // Register action handlers
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        if (!controller) return;

        navigator.mediaSession.setActionHandler("play", async () => {
            // Eagerly push position state before iOS defers JS execution
            if ("setPositionState" in navigator.mediaSession) {
                const duration = controller.getDuration();
                const position = controller.getCurrentTime();
                if (duration > 0) {
                    try {
                        navigator.mediaSession.setPositionState({
                            duration,
                            playbackRate: 1,
                            position: Math.min(position, duration),
                        });
                    } catch {
                        // Position state not supported
                    }
                }
            }

            // Clear interrupt flag — user is explicitly requesting play
            controller.clearInterruptFlag();

            try {
                await controller.play();
            } catch {
                // play() failed (iOS audio session may be invalidated).
                // Reload source and try again — this re-establishes the
                // audio hardware connection that iOS drops on interruption.
                controller.reloadAndPlay();
            }
        });

        navigator.mediaSession.setActionHandler("pause", () => {
            controller.pause();
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
                seekRef.current(currentTimeRef.current + 30);
            }
        });

        try {
            navigator.mediaSession.setActionHandler("seekbackward", (details) => {
                const skip = details.seekOffset || 10;
                seekRef.current(Math.max(currentTimeRef.current - skip, 0));
            });

            navigator.mediaSession.setActionHandler("seekforward", (details) => {
                const skip = details.seekOffset || 10;
                seekRef.current(currentTimeRef.current + skip);
            });

            navigator.mediaSession.setActionHandler("seekto", (details) => {
                if (details.seekTime !== undefined) {
                    seekRef.current(details.seekTime);
                }
            });
        } catch {
            // Seek actions not supported
        }

        return () => {
            const actions: MediaSessionAction[] = [
                "play", "pause", "previoustrack", "nexttrack",
                "seekbackward", "seekforward", "seekto",
            ];
            actions.forEach((action) => {
                try { navigator.mediaSession.setActionHandler(action, null); } catch {}
            });
        };
    }, [controller]);

    // Metadata
    const getAbsoluteUrl = useCallback((url: string): string => {
        if (!url) return "";
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        if (typeof window !== "undefined") return `${window.location.origin}${url}`;
        return url;
    }, []);

    useEffect(() => {
        if (!("mediaSession" in navigator)) return;

        if (!currentTrack && !currentAudiobook && !currentPodcast) {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
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
                    ? [96, 128, 192, 256, 384, 512].map((s) => ({
                          src: coverUrl, sizes: `${s}x${s}`, type: "image/jpeg",
                      }))
                    : fallbackArtwork,
            });
        } else if (playbackType === "audiobook" && currentAudiobook) {
            const coverUrl = currentAudiobook.coverUrl
                ? getAbsoluteUrl(api.getCoverArtUrl(currentAudiobook.coverUrl, 512))
                : undefined;
            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentAudiobook.title,
                artist: currentAudiobook.author,
                album: currentAudiobook.narrator ? `Narrated by ${currentAudiobook.narrator}` : "Audiobook",
                artwork: coverUrl
                    ? [96, 128, 192, 256, 384, 512].map((s) => ({
                          src: coverUrl, sizes: `${s}x${s}`, type: "image/jpeg",
                      }))
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
                    ? [96, 128, 192, 256, 384, 512].map((s) => ({
                          src: coverUrl, sizes: `${s}x${s}`, type: "image/jpeg",
                      }))
                    : fallbackArtwork,
            });
        } else {
            navigator.mediaSession.metadata = null;
        }
    }, [currentTrack, currentAudiobook, currentPodcast, playbackType, getAbsoluteUrl]);

    // Position state for lock screen scrubbing (throttled to every 5s)
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        if (!("setPositionState" in navigator.mediaSession)) return;

        const now = Date.now();
        if (now - lastPositionUpdateRef.current < 5000) return;

        const duration = currentTrack?.duration || currentAudiobook?.duration || currentPodcast?.duration;
        if (duration && currentTime !== undefined) {
            try {
                navigator.mediaSession.setPositionState({
                    duration,
                    playbackRate: 1,
                    position: Math.min(currentTime, duration),
                });
                lastPositionUpdateRef.current = now;
            } catch (error) {
                console.warn("[MediaSession] Failed to set position state:", error);
            }
        }
    }, [currentTime, currentTrack, currentAudiobook, currentPodcast]);
}
