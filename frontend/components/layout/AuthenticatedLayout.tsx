"use client";

import { useAuth } from "@/lib/auth-context";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { TVLayout } from "./TVLayout";
import { BottomNavigation } from "./BottomNavigation";
import { UniversalPlayer } from "../player/UniversalPlayer";
import { MediaControlsHandler } from "../player/MediaControlsHandler";
import { WhatsNewGate } from "@/components/whats-new/WhatsNewGate";
import { PlayerModeWrapper } from "../player/PlayerModeWrapper";
import { ActivityPanel } from "./ActivityPanel";
import { UnifiedPanel } from "./UnifiedPanel";
import { GalaxyBackground } from "../ui/GalaxyBackground";
import { GradientSpinner } from "../ui/GradientSpinner";
import { ReactNode } from "react";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useIsTV } from "@/lib/tv-utils";
import { useActivityPanel, type ActivityPanelTab } from "@/hooks/useActivityPanel";

// Paths that render without the sidebar, top bar and player. Not the same list
// as auth-context's (no login) or ConditionalAudioProvider's (no audio): /share
// needs audio but no chrome.
const publicPaths = ["/login", "/onboarding", "/sync", "/share"];

/** Lets a keyboard skip the navigation; every layout's main element is #main-content. */
function SkipLink() {
    return (
        <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-(--z-panel) focus:px-4 focus:py-2 focus:bg-white focus:text-black focus:rounded-lg focus:font-medium"
        >
            skip to main content
        </a>
    );
}

export function AuthenticatedLayout({ children }: { children: ReactNode }) {
    const { isAuthenticated, isLoading } = useAuth();
    const pathname = usePathname();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isTV = useIsTV();
    const isMobileOrTablet = isMobile || isTablet;
    const activityPanel = useActivityPanel();
    const { toggle, open, close, setActiveTab, leaveSettings } = activityPanel;

    useEffect(() => {
        const handleToggle = () => toggle();
        const handleOpen = () => open();
        const handleClose = () => close();
        const handleSetTab = (
            e: CustomEvent<{ tab: ActivityPanelTab }>
        ) => {
            setActiveTab(e.detail.tab);
        };
        window.addEventListener("toggle-activity-panel", handleToggle);
        window.addEventListener("open-activity-panel", handleOpen);
        window.addEventListener("close-activity-panel", handleClose);
        window.addEventListener(
            "set-activity-panel-tab",
            handleSetTab as EventListener
        );
        window.addEventListener("leave-activity-panel-settings", leaveSettings);

        return () => {
            window.removeEventListener("toggle-activity-panel", handleToggle);
            window.removeEventListener("open-activity-panel", handleOpen);
            window.removeEventListener("close-activity-panel", handleClose);
            window.removeEventListener(
                "set-activity-panel-tab",
                handleSetTab as EventListener
            );
            window.removeEventListener("leave-activity-panel-settings", leaveSettings);
        };
    }, [toggle, open, close, setActiveTab, leaveSettings]);

    const isPublicPage = publicPaths.some(
        (p) => pathname === p || pathname.startsWith(p + "/")
    );

    // Show loading state only on protected pages
    if (!isPublicPage && isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-black">
                <div className="flex flex-col items-center gap-4">
                    <GradientSpinner size="lg" />
                    <p className="text-[var(--text-secondary)] text-sm">Loading...</p>
                </div>
            </div>
        );
    }

    // Public pages render without the sidebar, player and top bar
    if (isPublicPage) {
        return <>{children}</>;
    }

    if (isAuthenticated) {
        // A television: the 10-foot layout driven by a remote.
        if (isTV) {
            return (
                <PlayerModeWrapper>
                    <SkipLink />
                    <MediaControlsHandler />
                    <WhatsNewGate />
                    <TVLayout>{children}</TVLayout>
                </PlayerModeWrapper>
            );
        }

        if (isMobileOrTablet) {
            return (
                <PlayerModeWrapper>
                    <SkipLink />
                    <div className="h-dvh bg-black overflow-hidden flex flex-col">
                        <MediaControlsHandler />
                        <WhatsNewGate />
                        <TopBar />

                        {/* On a phone or tablet the sidebar is the menu the top bar's button opens. */}
                        <Sidebar />

                        {/* The activity overlay: alerts, downloads, imports and history. */}
                        <ActivityPanel
                            isOpen={activityPanel.isOpen}
                            onToggle={activityPanel.toggle}
                            activeTab={activityPanel.activeTab}
                            onTabChange={activityPanel.setActiveTab}
                        />

                        <main
                            id="main-content"
                            tabIndex={-1}
                            className="flex-1 bg-gradient-to-b from-[#1a1a1a] via-black to-black mx-2 mb-2 rounded-lg overflow-y-auto relative focus:outline-none"
                            style={{
                                marginTop: "calc(var(--topbar-h) + var(--standalone-safe-area-top, 0px))",
                                marginBottom: "calc(var(--nav-h) + var(--standalone-safe-area-bottom, 0px))",
                            }}
                        >
                            <GalaxyBackground />
                            <div className="h-full">{children}</div>
                        </main>

                        {/* The mini player, fixed above the tab bar. */}
                        <UniversalPlayer />

                        <BottomNavigation />
                    </div>
                </PlayerModeWrapper>
            );
        }

        return (
            <PlayerModeWrapper>
                <SkipLink />
                <div
                    className="h-dvh bg-black overflow-hidden flex flex-col"
                    style={{ paddingTop: "calc(64px + var(--titlebar-height, 0px))" }}
                >
                    <MediaControlsHandler />
                    <WhatsNewGate />
                    <TopBar />
                    <div className="flex-1 flex gap-2 p-2 pt-0 overflow-hidden">
                        <Sidebar />
                        <main
                            id="main-content"
                            tabIndex={-1}
                            className="flex-1 bg-gradient-to-b from-[#1a1a1a] via-black to-black rounded-lg overflow-y-auto relative focus:outline-none"
                        >
                            {pathname !== "/vibe" && <GalaxyBackground />}
                            {children}
                        </main>
                        <UnifiedPanel
                            isOpen={activityPanel.isOpen}
                            onToggle={activityPanel.toggle}
                        />
                    </div>
                    <UniversalPlayer />
                </div>
            </PlayerModeWrapper>
        );
    }

    // If not authenticated on a protected page, auth context will redirect
    return (
        <div className="min-h-screen flex items-center justify-center bg-black">
            <div className="flex flex-col items-center gap-4">
                <GradientSpinner size="lg" />
                <p className="text-[var(--text-secondary)] text-sm">Redirecting...</p>
            </div>
        </div>
    );
}
