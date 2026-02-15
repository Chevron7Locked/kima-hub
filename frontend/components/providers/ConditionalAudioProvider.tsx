"use client";

import { usePathname } from "next/navigation";
import { AudioStateProvider } from "@/lib/audio-state-context";
import { AudioPlaybackProvider } from "@/lib/audio-playback-context";
import { AudioControlsProvider } from "@/lib/audio-controls-context";
import { useAuth } from "@/lib/auth-context";
import { AudioElement } from "@/components/player/AudioElement";
import { AudioErrorBoundary } from "@/components/providers/AudioErrorBoundary";

export function ConditionalAudioProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const pathname = usePathname();
    const { isAuthenticated } = useAuth();

    // Don't load audio provider on public pages or when not authenticated
    const publicPages = ["/login", "/register", "/onboarding", "/setup"];
    const isPublicPage = publicPages.includes(pathname);

    if (isPublicPage || !isAuthenticated) {
        return <>{children}</>;
    }

    // Split contexts: State -> Playback -> Controls
    // This prevents re-renders from currentTime updates affecting all consumers
    // Wrapped in error boundary to prevent audio errors from crashing the app
    return (
        <AudioErrorBoundary>
            <AudioStateProvider>
                <AudioPlaybackProvider>
                    <AudioControlsProvider>
                        <AudioElement />
                        {children}
                    </AudioControlsProvider>
                </AudioPlaybackProvider>
            </AudioStateProvider>
        </AudioErrorBoundary>
    );
}
