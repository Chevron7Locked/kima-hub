import { useState, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { howlerEngine } from "@/lib/howler-engine";

export function usePreviewPlayer() {
    const [currentPreview, setCurrentPreview] = useState<string | null>(null);
    const [previewAudios, setPreviewAudios] = useState<
        Map<string, HTMLAudioElement>
    >(new Map());
    const mainPlayerWasPausedRef = useRef(false);

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            previewAudios.forEach((audio) => {
                audio.pause();
                audio.src = "";
            });
            // Resume main player if needed
            if (mainPlayerWasPausedRef.current) {
                howlerEngine.play();
                mainPlayerWasPausedRef.current = false;
            }
        };
    }, [previewAudios]);

    const handleTogglePreview = useCallback(
        (albumId: string, previewUrl: string) => {
            if (!previewUrl) {
                toast.error("No preview available for this album");
                return;
            }

            // Stop currently playing preview and destroy it
            if (currentPreview && currentPreview !== albumId) {
                const audio = previewAudios.get(currentPreview);
                if (audio) {
                    audio.pause();
                    audio.src = "";
                    audio.load();
                }
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
                    howlerEngine.play();
                    mainPlayerWasPausedRef.current = false;
                }
            } else {
                // Pause the main player if it's playing
                if (howlerEngine.isPlaying()) {
                    howlerEngine.pause();
                    mainPlayerWasPausedRef.current = true;
                }

                let audio = previewAudios.get(albumId);
                if (!audio) {
                    audio = new Audio(previewUrl);
                    audio.onended = () => {
                        setCurrentPreview(null);
                        // Resume main player if it was playing before
                        if (mainPlayerWasPausedRef.current) {
                            howlerEngine.play();
                            mainPlayerWasPausedRef.current = false;
                        }
                    };
                    audio.onerror = () => {
                        toast.error("Failed to load preview");
                        setCurrentPreview(null);
                        if (mainPlayerWasPausedRef.current) {
                            howlerEngine.play();
                            mainPlayerWasPausedRef.current = false;
                        }
                    };
                    const newMap = new Map(previewAudios);
                    newMap.set(albumId, audio);
                    setPreviewAudios(newMap);
                }

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
        [currentPreview, previewAudios]
    );

    return {
        currentPreview,
        handleTogglePreview,
    };
}
