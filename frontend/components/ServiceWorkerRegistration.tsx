"use client";

import { useEffect, useState, useCallback } from "react";
import { applyIosDebugQueryFlag } from "@/lib/iosAudioLog";

export function ServiceWorkerRegistration() {
    const [updateAvailable, setUpdateAvailable] = useState(false);

    useEffect(() => {
        applyIosDebugQueryFlag();
    }, []);

    useEffect(() => {
        if (!("serviceWorker" in navigator)) return;

        navigator.serviceWorker.register("/sw.js").then((reg) => {
            // A SW was already waiting when this page loaded (e.g. user had the app open in another tab)
            if (reg.waiting) {
                setUpdateAvailable(true);
                return;
            }

            reg.addEventListener("updatefound", () => {
                const newWorker = reg.installing;
                if (!newWorker) return;
                newWorker.addEventListener("statechange", () => {
                    // installed + existing controller = new version waiting to take over
                    if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                        setUpdateAvailable(true);
                    }
                });
            });
        }).catch(() => {
            // Registration failed -- not critical, app still works
        });
    }, []);

    const handleReload = useCallback(() => {
        navigator.serviceWorker.ready.then((reg) => {
            reg.waiting?.postMessage({ type: "SKIP_WAITING" });
        });
        // Reload once the new SW takes control
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            window.location.reload();
        }, { once: true });
    }, []);

    if (!updateAvailable) return null;

    return (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[200] bg-[var(--bg-hover)] border border-white/10 rounded-lg px-4 py-3 flex items-center gap-3 shadow-xl text-sm whitespace-nowrap">
            <span className="text-white/60">New version available</span>
            <button
                onClick={handleReload}
                className="px-3 py-1 bg-white text-black rounded-md text-xs font-medium hover:bg-white/90 transition-colors"
            >
                Reload
            </button>
            <button
                onClick={() => setUpdateAvailable(false)}
                className="text-white/30 hover:text-white/60 text-xs transition-colors"
            >
                Later
            </button>
        </div>
    );
}
