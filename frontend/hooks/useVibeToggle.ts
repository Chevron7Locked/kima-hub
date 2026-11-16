"use client";

import { useState, useCallback } from "react";
import { useActiveOperation, useCurrentMedia } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { notify } from "@/lib/notify";

export function useVibeToggle() {
    const { currentTrack } = useCurrentMedia();
    const activeOperation = useActiveOperation();
    const { startVibeMode, stopVibeMode } = useAudioControls();
    const [isVibeLoading, setIsVibeLoading] = useState(false);

    const handleVibeToggle = useCallback(async () => {
        if (!currentTrack?.id) return;

        if (activeOperation.type !== "idle") {
            stopVibeMode();
            return;
        }

        setIsVibeLoading(true);
        try {
            const result = await startVibeMode();

            if (!result.success || result.trackCount <= 0) {
                notify.error("Couldn't find matching tracks in your library");
            }
        } catch {
            notify.error("Failed to match vibe");
        } finally {
            setIsVibeLoading(false);
        }
    }, [currentTrack?.id, activeOperation.type, startVibeMode, stopVibeMode]);

    return { handleVibeToggle, isVibeLoading };
}
