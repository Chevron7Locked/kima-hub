"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useState, useEffect, lazy, Suspense } from "react";

// Lazy load VibeOverlayEnhanced - only loads when vibe mode is active
const EnhancedVibeOverlay = lazy(() => import("./VibeOverlayEnhanced").then(mod => ({ default: mod.EnhancedVibeOverlay })));

/**
 * Container component that manages the floating EnhancedVibeOverlay.
 * Shows automatically when vibe mode is active on desktop.
 */
export function VibeOverlayContainer() {
    const { vibeMode, queue, currentIndex } = useAudioState();
    const [isVisible, setIsVisible] = useState(false);
    const [isDismissed, setIsDismissed] = useState(false);

    // Auto-show when vibe mode activates, reset dismissed state
    useEffect(() => {
        if (vibeMode) {
            setIsVisible(true);
            setIsDismissed(false);
        } else {
            setIsVisible(false);
            setIsDismissed(false);
        }
    }, [vibeMode]);

    // Get current track's audio features from the queue
    const currentTrackFeatures = queue[currentIndex]?.audioFeatures || null;

    // Don't render if not in vibe mode or dismissed
    if (!vibeMode || isDismissed || !isVisible) return null;

    return (
        <Suspense fallback={null}>
            <EnhancedVibeOverlay
                currentTrackFeatures={currentTrackFeatures}
                variant="floating"
                onClose={() => setIsDismissed(true)}
            />
        </Suspense>
    );
}