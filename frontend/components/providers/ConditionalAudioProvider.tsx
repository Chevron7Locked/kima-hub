"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AudioStateProvider } from "@/lib/audio-state-context";
import { AudioPlaybackProvider } from "@/lib/audio-playback-context";
import { AudioControlsProvider } from "@/lib/audio-controls-context";
import { AudioControllerContext } from "@/lib/audio-controller-context";
import { AudioController } from "@/lib/audio-controller";
import { useAuth } from "@/lib/auth-context";
import { AudioErrorBoundary } from "@/components/providers/AudioErrorBoundary";

function AudioProviderInner({ children }: { children: React.ReactNode }) {
    const [controller, setController] = useState<AudioController | null>(null);

    useEffect(() => {
        const ctrl = new AudioController();
        // The owned <audio> element + AudioContext must be created here (not in
        // a lazy useState initializer) so Strict Mode's double-invoke
        // create -> cleanup -> create cycle can't leak a duplicate DOM element;
        // exposing the instance to the context value then requires this setState.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setController(ctrl);

        return () => {
            ctrl.destroy();
            setController(null);
        };
    }, []);

    return (
        <AudioControllerContext.Provider value={controller}>
            <AudioStateProvider>
                <AudioPlaybackProvider>
                    <AudioControlsProvider>
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
