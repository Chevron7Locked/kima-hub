"use client";

import { useEffect, useRef, useState } from "react";

/**
 * True once the element scrolls into view, and from then on (the observer disconnects, so an entrance never replays).
 * `withinMain` measures against the page's scrolling area (#main-content) instead of the window, so a `rootMargin`
 * that reaches past the screen is not clipped away; use it to start work before the element arrives.
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(options?: {
    /** How much of it has to be showing. A whole section is never fully on screen. */
    threshold?: number;
    /** Start a little before the edge, so it is already moving as it appears. */
    rootMargin?: string;
    withinMain?: boolean;
}) {
    const ref = useRef<T | null>(null);
    const [shown, setShown] = useState(false);

    // No IntersectionObserver (an old browser, a test renderer): shown at once, since hidden content is a broken
    // page and a missing entrance is not. False on the server so hydration matches.
    const noObserver = typeof window !== "undefined" && typeof IntersectionObserver === "undefined";
    const threshold = options?.threshold ?? 0.12;
    const rootMargin = options?.rootMargin ?? "0px 0px -8% 0px";
    const withinMain = options?.withinMain ?? false;

    useEffect(() => {
        const node = ref.current;
        if (!node || shown || noObserver) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setShown(true);
                    observer.disconnect();
                }
            },
            { root: withinMain ? node.closest<HTMLElement>("#main-content") : null, threshold, rootMargin },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [shown, noObserver, threshold, rootMargin, withinMain]);

    return { ref, shown: shown || noObserver };
}
