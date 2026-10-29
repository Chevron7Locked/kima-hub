import { useState } from "react";

function isAndroidTV(): boolean {
    if (typeof window === "undefined") return false;

    const ua = navigator.userAgent.toLowerCase();
    const isTV = ua.includes("android tv") ||
                 ua.includes("googletv") ||
                 ua.includes("aftb") || // Fire TV
                 ua.includes("aftt") || // Fire TV Stick
                 ua.includes("afts") || // Fire TV
                 ua.includes("aftm") || // Fire TV
                 (ua.includes("android") && ua.includes("tv"));

    // Also check for large screen with no touch (TV indicator)
    const isLargeScreen = window.innerWidth >= 1920;
    const noTouch = !('ontouchstart' in window);

    // Check URL param for testing: ?tv=1
    const urlParams = new URLSearchParams(window.location.search);
    const tvParam = urlParams.get('tv') === '1';

    return isTV || tvParam || (isLargeScreen && noTouch && ua.includes("android"));
}

export function useIsTV(): boolean {
    const [isTV] = useState(() => isAndroidTV());
    return isTV;
}

export const DPAD_KEYS = {
    UP: "ArrowUp",
    DOWN: "ArrowDown",
    LEFT: "ArrowLeft",
    RIGHT: "ArrowRight",
    CENTER: "Enter",
    BACK: "Escape",
    PLAY_PAUSE: "MediaPlayPause",
    FAST_FORWARD: "MediaFastForward",
    REWIND: "MediaRewind",
} as const;
