import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { audioEngine } from "@/lib/audio-engine";
import { useAudioState } from "@/lib/audio-state-context";

interface PreviewableTrack {
    id: string;
    title: string;
}

export function useTrackPreview<T extends PreviewableTrack>() {
    const { toast } = useToast();
    const { volume, isMuted } = useAudioState();
    const [previewTrack, setPreviewTrack] = useState<string | null>(null);
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);
    const mainPlayerWasPausedRef = useRef(false);
    const previewRequestIdRef = useRef(0);
    const noPreviewTrackIdsRef = useRef<Set<string>>(new Set());
    const toastShownForNoPreviewRef = useRef<Set<string>>(new Set());
    const inFlightTrackIdRef = useRef<string | null>(null);

    const applyCurrentPlayerVolume = useCallback((audio: HTMLAudioElement) => {
        audio.volume = isMuted ? 0 : volume;
    }, [volume, isMuted]);

    const isAbortError = (err: unknown) => {
        if (!err || typeof err !== "object") return false;
        const e = err as Record<string, unknown>;
        const name = typeof e.name === "string" ? e.name : "";
        const code = typeof e.code === "number" ? e.code : undefined;
        const message = typeof e.message === "string" ? e.message : "";
        return (
            name === "AbortError" ||
            code === 20 ||
            message.includes("interrupted by a call to pause")
        );
    };

    const showNoPreviewToast = (trackId: string) => {
        if (toastShownForNoPreviewRef.current.has(trackId)) return;
        toastShownForNoPreviewRef.current.add(trackId);
        toast.info("No Deezer preview available");
    };

    const handlePreview = async (
        track: T,
        artistName: string,
        e: React.MouseEvent
    ) => {
        e.stopPropagation();

        // If the same track is playing, pause it
        if (previewTrack === track.id && previewPlaying) {
            previewAudioRef.current?.pause();
            setPreviewPlaying(false);
            return;
        }

        // If the same track is paused, resume it
        if (previewTrack === track.id && !previewPlaying && previewAudioRef.current) {
            try {
                applyCurrentPlayerVolume(previewAudioRef.current);
                await previewAudioRef.current.play();
            } catch (err: unknown) {
                if (isAbortError(err)) return;
                console.error("Preview error:", err);
            }
            setPreviewPlaying(true);
            return;
        }

        // Different track -- stop current and fully destroy old Audio element
        if (previewAudioRef.current) {
            previewAudioRef.current.pause();
            previewAudioRef.current.src = "";
            previewAudioRef.current.load();
            previewAudioRef.current = null;
        }

        try {
            if (inFlightTrackIdRef.current === track.id) return;
            if (noPreviewTrackIdsRef.current.has(track.id)) {
                showNoPreviewToast(track.id);
                return;
            }

            const requestId = ++previewRequestIdRef.current;
            inFlightTrackIdRef.current = track.id;

            const response = await api.getTrackPreview(artistName, track.title);
            if (requestId !== previewRequestIdRef.current) return;

            if (!response.previewUrl) {
                noPreviewTrackIdsRef.current.add(track.id);
                showNoPreviewToast(track.id);
                return;
            }

            if (audioEngine.isPlaying()) {
                audioEngine.pause();
                mainPlayerWasPausedRef.current = true;
            }

            const audio = new Audio(response.previewUrl);
            applyCurrentPlayerVolume(audio);
            previewAudioRef.current = audio;

            audio.onended = () => {
                setPreviewPlaying(false);
                setPreviewTrack(null);
                if (mainPlayerWasPausedRef.current) {
                    audioEngine.play();
                    mainPlayerWasPausedRef.current = false;
                }
            };

            audio.onerror = () => {
                toast.error("Failed to play preview");
                setPreviewPlaying(false);
                setPreviewTrack(null);
                if (mainPlayerWasPausedRef.current) {
                    audioEngine.play();
                    mainPlayerWasPausedRef.current = false;
                }
            };

            try {
                await audio.play();
            } catch (err: unknown) {
                if (isAbortError(err)) return;
                throw err;
            }
            setPreviewTrack(track.id);
            setPreviewPlaying(true);
        } catch (error: unknown) {
            if (isAbortError(error)) return;
            if (
                typeof error === "object" &&
                error !== null &&
                (((error as Record<string, unknown>).error as unknown) ===
                    "Preview not found" ||
                    /preview not found/i.test(
                        String((error as Record<string, unknown>).message || "")
                    ))
            ) {
                noPreviewTrackIdsRef.current.add(track.id);
                showNoPreviewToast(track.id);
                return;
            }
            console.error("Failed to play preview:", error);
            toast.error("Failed to play preview");
            setPreviewPlaying(false);
            setPreviewTrack(null);
        } finally {
            if (inFlightTrackIdRef.current === track.id) {
                inFlightTrackIdRef.current = null;
            }
        }
    };

    useEffect(() => {
        if (previewAudioRef.current) {
            applyCurrentPlayerVolume(previewAudioRef.current);
        }
    }, [applyCurrentPlayerVolume]);

    useEffect(() => {
        const stopPreview = () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current.src = "";
                previewAudioRef.current.load();
                previewAudioRef.current = null;
                setPreviewPlaying(false);
                setPreviewTrack(null);
                mainPlayerWasPausedRef.current = false;
            }
        };

        audioEngine.on("play", stopPreview);
        return () => {
            audioEngine.off("play", stopPreview);
        };
    }, []);

    useEffect(() => {
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current.src = "";
                previewAudioRef.current.load();
                previewAudioRef.current = null;
            }
            if (mainPlayerWasPausedRef.current) {
                audioEngine.play();
                mainPlayerWasPausedRef.current = false;
            }
        };
    }, []);

    return {
        previewTrack,
        previewPlaying,
        handlePreview,
    };
}
