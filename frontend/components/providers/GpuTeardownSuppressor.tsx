"use client";

import { useEffect } from "react";

/**
 * Swallow one specific harmless error thrown after the vibe map is torn down.
 *
 * deck.gl's luma.gl keeps a ResizeObserver that can fire once more after its GPU device
 * has been destroyed, and reads `device.limits.maxTextureDimension2D` off an object that
 * is by then undefined. Nothing is broken -- the page it belonged to is already gone --
 * but it arrives as an uncaught error, so an error boundary cannot catch it (it is an
 * async callback) and any error reporting will log it.
 *
 * This used to live inside the vibe page itself, which could not work: the handler was
 * removed when that page unmounted, and unmounting is exactly what triggers the error.
 * The result was that leaving the vibe map threw on whichever page you went to next,
 * where it looked like a fault in that page. Mounted at the root, the suppressor is still
 * listening when the late callback finally runs.
 *
 * Deliberately matched on the one message. Anything else from luma.gl still surfaces.
 */
export function GpuTeardownSuppressor() {
    useEffect(() => {
        const handler = (e: ErrorEvent) => {
            if (e.message?.includes("maxTextureDimension2D")) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        };
        // Capture phase, so this runs before the Next.js dev overlay picks it up.
        window.addEventListener("error", handler, true);
        return () => window.removeEventListener("error", handler, true);
    }, []);

    return null;
}
