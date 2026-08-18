import { useSyncExternalStore } from "react";

/**
 * Hook to check if a media query matches
 * Uses useSyncExternalStore for hydration-safe initial state
 */
export function useMediaQuery(query: string): boolean {
    // Use useSyncExternalStore for hydration-safe media query detection
    // This prevents the flash caused by useState(false) -> useEffect(true) pattern
    const matches = useSyncExternalStore(
        // Subscribe function
        (callback) => {
            if (typeof window === "undefined") return () => {};
            const media = window.matchMedia(query);
            media.addEventListener("change", callback);
            return () => media.removeEventListener("change", callback);
        },
        // Get client snapshot
        () => {
            if (typeof window === "undefined") return false;
            return window.matchMedia(query).matches;
        },
        // Get server snapshot (always false on server)
        () => false
    );

    return matches;
}

// Common breakpoints
export const useIsMobile = () => useMediaQuery("(max-width: 768px)");

/**
 * "Tablet" here means "give this the thumb-reachable chrome": the bottom
 * navigation bar rather than the sidebar.
 *
 * It is two conditions joined by a comma, which in a media query means OR.
 *
 *   1. 769-1024px on any input. This is the original rule and it is kept so a
 *      desktop window dragged narrow still collapses to the compact chrome.
 *
 *   2. 769-1366px on a device that cannot hover at all. This is the tablet
 *      itself, and the ceiling is set by the iPad Pro 12.9" in landscape.
 *
 * The second clause exists because the first one alone changed navigation
 * paradigm when you rotated. An iPad in portrait is 1024 wide and matched, so
 * it got the bottom bar; rotated to landscape it is 1366, missed, and got the
 * sidebar instead. Same device, same session, and the navigation moved from
 * the bottom of the screen to the top-left corner.
 *
 * `any-hover: none` rather than `hover: none` is deliberate. It is true only
 * when NO input mechanism available to the device can hover, so a laptop with
 * both a touchscreen and a trackpad still reports hover and keeps its sidebar
 * -- a touchscreen is not a reason to take the desktop layout away from it.
 */
export const useIsTablet = () =>
    useMediaQuery(
        "(min-width: 769px) and (max-width: 1024px), " +
            "(min-width: 769px) and (max-width: 1366px) and (any-hover: none) and (pointer: coarse)"
    );
