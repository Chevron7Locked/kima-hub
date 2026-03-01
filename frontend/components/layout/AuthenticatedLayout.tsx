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
import { PlayerModeWrapper } from "../player/PlayerModeWrapper";
import { ActivityPanel } from "./ActivityPanel";
import { GalaxyBackground } from "../ui/GalaxyBackground";
import { GradientSpinner } from "../ui/GradientSpinner";
import { ReactNode } from "react";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useIsTV } from "@/lib/tv-utils";
import { useActivityPanel } from "@/hooks/useActivityPanel";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";

const publicPaths = ["/login", "/register", "/onboarding", "/sync"];

export function AuthenticatedLayout({ children }: { children: ReactNode }) {
    const { isAuthenticated, isLoading } = useAuth();
    const pathname = usePathname();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isTV = useIsTV();
    const isMobileOrTablet = isMobile || isTablet;
    const activityPanel = useActivityPanel();
    const { settingsContent, setSettingsContent } = useActivityPanelSettings();

    // Listen for activity panel events (toggle/open/close/tab)
    useEffect(() => {
        const handleToggle = () => activityPanel.toggle();
        const handleOpen = () => activityPanel.open();
        const handleClose = () => activityPanel.close();
        const handleSetTab = (
            e: CustomEvent<{ tab: "notifications" | "active" | "history" | "settings" }>
        ) => {
            activityPanel.setActiveTab(e.detail.tab);
        };
        window.addEventListener("toggle-activity-panel", handleToggle);
        window.addEventListener("open-activity-panel", handleOpen);
        window.addEventListener("close-activity-panel", handleClose);
        window.addEventListener(
            "set-activity-panel-tab",
            handleSetTab as EventListener
        );

        return () => {
            window.removeEventListener("toggle-activity-panel", handleToggle);
            window.removeEventListener("open-activity-panel", handleOpen);
            window.removeEventListener("close-activity-panel", handleClose);
            window.removeEventListener(
                "set-activity-panel-tab",
                handleSetTab as EventListener
            );
        };
    }, [activityPanel]);

    const isPublicPage = publicPaths.includes(pathname);

    // Show loading state only on protected pages
    if (!isPublicPage && isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-black">
                <div className="flex flex-col items-center gap-4">
                    <GradientSpinner size="lg" />
                    <p className="text-white/60 text-sm">Loading...</p>
                </div>
            </div>
        );
    }

    // On public pages (login/register), don't show sidebar/player/topbar
    if (isPublicPage) {
        return <>{children}</>;
    }

    // On protected pages, show appropriate layout based on device
    if (isAuthenticated) {
        // Android TV Layout - Optimized for 10-foot UI
        if (isTV) {
            return (
                <PlayerModeWrapper>
                    <a
                        href="#main-content"
                        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-white focus:text-black focus:rounded-lg focus:font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        Skip to main content
                    </a>
                    <MediaControlsHandler />
                    <TVLayout>{children}</TVLayout>
                </PlayerModeWrapper>
            );
        }

        // Mobile/Tablet Layout
        if (isMobileOrTablet) {
            return (
                <PlayerModeWrapper>
                    <a
                        href="#main-content"
                        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-white focus:text-black focus:rounded-lg focus:font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                        Skip to main content
                    </a>
                    <div className="h-screen bg-black overflow-hidden flex flex-col">
                        <MediaControlsHandler />
                        <TopBar />

                        {/* Sidebar - renders MobileSidebar for hamburger menu */}
                        <Sidebar />

                        {/* Activity Panel - for mobile notifications (rendered as overlay) */}
                        <ActivityPanel
                            isOpen={activityPanel.isOpen}
                            onToggle={activityPanel.toggle}
                            activeTab={activityPanel.activeTab}
                            onTabChange={activityPanel.setActiveTab}
                            settingsContent={settingsContent}
                            onSettingsDismissed={() => setSettingsContent(null)}
                        />

                        {/* Main content area with rounded corners */}
                        <main
                            id="main-content"
                            tabIndex={-1}
                            className="flex-1 bg-gradient-to-b from-[#1a1a1a] via-black to-black mx-2 mb-2 rounded-lg overflow-y-auto relative focus:outline-none"
                            style={{
                                marginTop: "calc(58px + var(--standalone-safe-area-top, 0px))",
                                marginBottom: "calc(56px + var(--standalone-safe-area-bottom, 0px))",
                            }}
                        >
                            <GalaxyBackground />
                            <div>{children}</div>
                        </main>

                        {/* Mini Player - fixed, positioned above bottom nav */}
                        <UniversalPlayer />

                        {/* Bottom Navigation - fixed at bottom */}
                        <BottomNavigation />
                    </div>
                </PlayerModeWrapper>
            );
        }

        // Desktop Layout
        return (
            <PlayerModeWrapper>
                <a
                    href="#main-content"
                    className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-white focus:text-black focus:rounded-lg focus:font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                    Skip to main content
                </a>
                <div
                    className="h-screen bg-black overflow-hidden flex flex-col"
                    style={{ paddingTop: "64px" }}
                >
                    <MediaControlsHandler />
                    <TopBar />
                    <div className="flex-1 flex gap-2 p-2 pt-0 overflow-hidden">
                        <Sidebar />
                        <main
                            id="main-content"
                            tabIndex={-1}
                            className="flex-1 bg-gradient-to-b from-[#1a1a1a] via-black to-black rounded-lg overflow-y-auto relative focus:outline-none"
                        >
                            <GalaxyBackground />
                            {children}
                        </main>
                        <ActivityPanel
                            isOpen={activityPanel.isOpen}
                            onToggle={activityPanel.toggle}
                            activeTab={activityPanel.activeTab}
                            onTabChange={activityPanel.setActiveTab}
                            settingsContent={settingsContent}
                            onSettingsDismissed={() => setSettingsContent(null)}
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
                <p className="text-white/60 text-sm">Redirecting...</p>
            </div>
        </div>
    );
}
