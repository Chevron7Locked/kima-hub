import { useState, useCallback, useEffect, useRef } from "react";
import { useToast } from "@/lib/toast-context";
import { useAudioController } from "@/lib/audio-controller-context";
import { useAudioState } from "@/lib/audio-state-context";
import { api } from "@/lib/api";

export function usePreviewPlayer() {
    const controller = useAudioController();
    const { toast } = useToast();
    const { volume, isMuted } = useAudioState();
    const [currentPreview, setCurrentPreview] = useState<string | null>(null);
    const [previewAudios, setPreviewAudios] = useState<
        Map<string, HTMLAudioElement>
    >(new Map());
    const mainPlayerWasPausedRef = useRef(false);
    const previewAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());

    const applyCurrentPlayerVolume = useCallback((audio: HTMLAudioElement) => {
        audio.volume = isMuted ? 0 : volume;
    }, [volume, isMuted]);

    // Keep ref in sync
    useEffect(() => {
        previewAudiosRef.current = previewAudios;
    });

    useEffect(() => {
        previewAudiosRef.current.forEach((audio) => {
            applyCurrentPlayerVolume(audio);
        });
    }, [applyCurrentPlayerVolume]);

    // Cleanup only on unmount
    useEffect(() => {
        return () => {
            previewAudiosRef.current.forEach((audio) => {
                audio.pause();
                audio.src = "";
            });
            if (mainPlayerWasPausedRef.current) {
                controller?.play();
                mainPlayerWasPausedRef.current = false;
            }
        };
    }, [controller]);

    const handleTogglePreview = useCallback(
        (albumId: string, artistName: string, trackTitle: string) => {

            // Stop currently playing preview and destroy it
            if (currentPreview && currentPreview !== albumId) {
                const audio = previewAudios.get(currentPreview);
                if (audio) {
                    audio.pause();
                    audio.src = "";
                    audio.load();
                }
                const newMap = new Map(previewAudios);
                newMap.delete(currentPreview);
                setPreviewAudios(newMap);
            }

            // Toggle the clicked preview
            if (currentPreview === albumId) {
                const audio = previewAudios.get(albumId);
                if (audio) {
                    audio.pause();
                    audio.src = "";
                    audio.load();
                }
                // Remove from map to free memory
                const newMap = new Map(previewAudios);
                newMap.delete(albumId);
                setPreviewAudios(newMap);
                setCurrentPreview(null);
                // Resume main player if it was playing before
                if (mainPlayerWasPausedRef.current) {
                    controller?.play();
                    mainPlayerWasPausedRef.current = false;
                }
            } else {
                // Pause the main player if it's playing
                if (controller?.isPlaying()) {
                    controller?.pause();
                    mainPlayerWasPausedRef.current = true;
                }

                let audio = previewAudios.get(albumId);
                if (!audio) {
                    audio = new Audio(
                        api.getTrackPreviewStreamUrl(artistName, trackTitle)
                    );
                    applyCurrentPlayerVolume(audio);
                    audio.onended = () => {
                        setCurrentPreview(null);
                        // Resume main player if it was playing before
                        if (mainPlayerWasPausedRef.current) {
                            controller?.play();
                            mainPlayerWasPausedRef.current = false;
                        }
                    };
                    audio.onerror = () => {
                        toast.error("Failed to load preview");
                        setCurrentPreview(null);
                        if (mainPlayerWasPausedRef.current) {
                            controller?.play();
                            mainPlayerWasPausedRef.current = false;
                        }
                    };
                    const newMap = new Map(previewAudios);
                    newMap.set(albumId, audio);
                    setPreviewAudios(newMap);
                }

                applyCurrentPlayerVolume(audio);

                audio
                    .play()
                    .then(() => {
                        setCurrentPreview(albumId);
                    })
                    .catch((error) => {
                        toast.error("Failed to play preview: " + error.message);
                    });
            }
        },
        [toast, currentPreview, previewAudios, applyCurrentPlayerVolume, controller]
    );

    return {
        currentPreview,
        handleTogglePreview,
    };
}
