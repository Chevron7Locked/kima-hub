import { useEffect, useCallback, useRef } from "react";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioController } from "@/lib/audio-controller-context";
import { api } from "@/lib/api";
import { iosAudioLog } from "@/lib/iosAudioLog";
import type { EngineSnapshot } from "@/lib/audio-engine-policy";

export function useMediaSession() {
    const controller = useAudioController();
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
    } = useAudioState();
    const { currentTime } = useAudioPlayback();
    const { next, previous, seek, pause } = useAudioControls();

    const currentTimeRef = useRef(currentTime);
    const playbackTypeRef = useRef(playbackType);
    const nextRef = useRef(next);
    const previousRef = useRef(previous);
    const seekRef = useRef(seek);
    const pauseRef = useRef(pause);
    const lastPositionUpdateRef = useRef(0);

    useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
    useEffect(() => { playbackTypeRef.current = playbackType; }, [playbackType]);
    useEffect(() => { nextRef.current = next; }, [next]);
    useEffect(() => { previousRef.current = previous; }, [previous]);
    useEffect(() => { seekRef.current = seek; }, [seek]);
    useEffect(() => { pauseRef.current = pause; }, [pause]);

    // Sync playbackState from snapshot (single source of truth).
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        if (!controller) return;

         
        const unsubscribe = controller.subscribe((snap: EngineSnapshot) => {
            const { status } = snap;
            if (status === "playing") {
                navigator.mediaSession.playbackState = "playing";
                lastPositionUpdateRef.current = 0;
            } else if (status === "buffering" || status === "recovering") {
                // Brief self-healing transient -- keep the lock screen "playing" to
                // avoid flicker; it corrects to "paused" if the ladder resolves to
                // error/blocked/paused.
                navigator.mediaSession.playbackState = "playing";
            } else if (
                status === "paused" ||
                status === "blocked" ||
                status === "error" ||
                status === "idle" ||
                status === "loading"
            ) {
                navigator.mediaSession.playbackState = "paused";
            }
        });

        // ended still emitted as an event; map to paused for MediaSession.
        const onEnded = () => { navigator.mediaSession.playbackState = "paused"; };
        const onError = () => { navigator.mediaSession.playbackState = "paused"; };
        const onSeeked = () => {
            if (!("setPositionState" in navigator.mediaSession)) return;
            const duration = controller.getDuration();
            const position = controller.getCurrentTime();
            if (duration > 0) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration,
                        playbackRate: 1,
                        position: Math.min(position, duration),
                    });
                    lastPositionUpdateRef.current = Date.now();
                } catch {
                    // Position state not supported
                }
            }
        };
        controller.on("ended", onEnded);
        controller.on("error", onError);
        controller.on("seeked", onSeeked);

        return () => {
            if (typeof unsubscribe === "function") unsubscribe();
            controller.off("ended", onEnded);
            controller.off("error", onError);
            controller.off("seeked", onSeeked);
        };
    }, [controller]);

    // Register action handlers
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        if (!controller) return;

        navigator.mediaSession.setActionHandler("play", () => {
            iosAudioLog("ms:play", "useMediaSession", null, { hasController: !!controller });
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

            // play() handles retry-from-error/blocked internally; no catch needed.
            controller.play();
        });

        navigator.mediaSession.setActionHandler("pause", () => {
            iosAudioLog("ms:pause", "useMediaSession");
            // Route through context pause so lock-screen pauses are USER pauses,
            // matching the FE5 intent-correct routing (spec 4.1).
            pauseRef.current();
        });

        navigator.mediaSession.setActionHandler("previoustrack", () => {
            iosAudioLog("ms:prev", "useMediaSession");
            if (playbackTypeRef.current === "track") {
                previousRef.current();
            } else {
                seekRef.current(Math.max(currentTimeRef.current - 30, 0));
            }
        });

        navigator.mediaSession.setActionHandler("nexttrack", () => {
            iosAudioLog("ms:next", "useMediaSession");
            if (playbackTypeRef.current === "track") {
                nextRef.current();
            } else {
                seekRef.current(currentTimeRef.current + 30);
            }
        });

        try {
            navigator.mediaSession.setActionHandler("seekbackward", (details) => {
                iosAudioLog("ms:seekback", "useMediaSession");
                const skip = details.seekOffset || 10;
                seekRef.current(Math.max(currentTimeRef.current - skip, 0));
            });

            navigator.mediaSession.setActionHandler("seekforward", (details) => {
                iosAudioLog("ms:seekfwd", "useMediaSession");
                const skip = details.seekOffset || 10;
                seekRef.current(currentTimeRef.current + skip);
            });

            navigator.mediaSession.setActionHandler("seekto", (details) => {
                iosAudioLog("ms:seekto", "useMediaSession");
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
