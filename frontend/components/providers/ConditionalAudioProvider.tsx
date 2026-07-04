"use client";

import { useRef, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AudioStateProvider } from "@/lib/audio-state-context";
import { AudioPlaybackProvider } from "@/lib/audio-playback-context";
import { AudioControlsProvider } from "@/lib/audio-controls-context";
import { AudioControllerContext } from "@/lib/audio-controller-context";
import { AudioController } from "@/lib/audio-controller";
import { useAuth } from "@/lib/auth-context";
import { AudioErrorBoundary } from "@/components/providers/AudioErrorBoundary";

function AudioProviderInner({ children }: { children: React.ReactNode }) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [controller, setController] = useState<AudioController | null>(null);

    useEffect(() => {
        if (audioRef.current) {
            const ctrl = new AudioController(audioRef.current);
            setController(ctrl);

            return () => {
                ctrl.destroy();
                setController(null);
            };
        }
    }, []);

    return (
        <AudioControllerContext.Provider value={controller}>
            <AudioStateProvider>
                <AudioPlaybackProvider>
                    <AudioControlsProvider>
                        <audio ref={audioRef} playsInline preload="auto" crossOrigin="anonymous" style={{ display: "none" }} />
                        {children}
                    </AudioControlsProvider>
                </AudioPlaybackProvider>
            </AudioStateProvider>
        </AudioControllerContext.Provider>
    );
}

export function ConditionalAudioProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const pathname = usePathname();
    const { isAuthenticated, isLoading } = useAuth();

    const publicPages = ["/login", "/register", "/onboarding", "/setup"];
    const isPublicPage = publicPages.some(p => pathname === p || pathname.startsWith(p + "/"));

    // Public pages: render children directly without audio providers
    if (isPublicPage) {
        return <>{children}</>;
    }

    // Authenticated pages: wait for auth to resolve before rendering.
    // This prevents the tree shape from changing (Fragment -> AudioProviderInner)
    // which would cause React to unmount/remount all children and double-fire queries.
    if (isLoading) {
        return null;
    }

    if (!isAuthenticated) {
        return <>{children}</>;
    }

    return (
        <AudioErrorBoundary>
            <AudioProviderInner>
                {children}
            </AudioProviderInner>
        </AudioErrorBoundary>
    );
}
