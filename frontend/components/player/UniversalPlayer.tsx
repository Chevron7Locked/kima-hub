"use client";

import { useAudio } from "@/lib/audio-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { MiniPlayer } from "./MiniPlayer";
import { FullPlayer } from "./FullPlayer";
import { OverlayPlayer } from "./OverlayPlayer";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

export function UniversalPlayer() {
    const { overlayOpen, openOverlay, currentTrack, currentAudiobook, currentPodcast, isPlaying } =
        useAudio();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const pathname = usePathname();
    // The vibe page's sheet carries the now-playing row on phones, so the
    // floating player would be a second bar over the same track.
    const sheetOwnsPlayback = isMobileOrTablet && pathname === "/vibe";
    const lastMediaIdRef = useRef<string | null>(null);
    const hasAutoSwitchedRef = useRef(false);

    // Auto-switch to overlay mode on mobile/tablet when user starts playing media.
    // Only fires once per mount -- auto-advances don't re-open the overlay.
    useEffect(() => {
        if (!isMobileOrTablet) return;

        const currentMediaId =
            currentTrack?.id ||
            currentAudiobook?.id ||
            currentPodcast?.id ||
            null;

        const mediaChanged = currentMediaId && currentMediaId !== lastMediaIdRef.current;

        if (mediaChanged && isPlaying && !hasAutoSwitchedRef.current) {
            // Where the sheet carries the player, the track is already visible
            // and controllable; spend the one automatic switch so that leaving
            // the page does not open the overlay for a play the user just made.
            if (!sheetOwnsPlayback) openOverlay();
            hasAutoSwitchedRef.current = true;
        }

        lastMediaIdRef.current = currentMediaId;
    }, [currentTrack?.id, currentAudiobook?.id, currentPodcast?.id, isPlaying, isMobileOrTablet, sheetOwnsPlayback, openOverlay]);

    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    return (
        <>
            {/* The desktop bar shows even with nothing playing; the <audio> element lives in ConditionalAudioProvider. */}
            {overlayOpen && hasMedia ? (
                <OverlayPlayer />
            ) : isMobileOrTablet ? (
                /* On mobile/tablet: only mini player (no full player), except where the page owns it */
                sheetOwnsPlayback ? null : <MiniPlayer />
            ) : (
                /* Desktop: always show full-width bottom player */
                <FullPlayer />
            )}
        </>
    );
}
