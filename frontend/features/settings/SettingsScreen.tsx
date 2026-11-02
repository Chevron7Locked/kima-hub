"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { useAudioState } from "@/lib/audio-context";
import { useAuth } from "@/lib/auth-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { InlineStatus } from "@/components/ui/InlineStatus";
import { SettingsLayout } from "@/features/settings/components/ui";
import { useSettingsState } from "@/features/settings/SettingsState";
import { addressForOldSection, settingsPage, type SettingsPageSlug } from "@/features/settings/pages";

import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { SubsonicSection } from "@/features/settings/components/sections/SubsonicSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { ScrobblingSection } from "@/features/settings/components/sections/ScrobblingSection";
import { DownloadPreferencesSection } from "@/features/settings/components/sections/DownloadPreferencesSection";
import { PodcastsSection } from "@/features/settings/components/sections/PodcastsSection";
import { LidarrSection } from "@/features/settings/components/sections/LidarrSection";
import { AudiobookshelfSection } from "@/features/settings/components/sections/AudiobookshelfSection";
import { SoulseekSection } from "@/features/settings/components/sections/SoulseekSection";
import { ArtworkSection } from "@/features/settings/components/sections/ArtworkSection";
import { StoragePathsSection } from "@/features/settings/components/sections/StoragePathsSection";
import { CacheSection } from "@/features/settings/components/sections/CacheSection";
import { UserManagementSection } from "@/features/settings/components/sections/UserManagementSection";
import { CorruptTracksSection } from "@/features/settings/components/sections/CorruptTracksSection";
import { Button } from "@/components/ui/Button";


/** One settings page: the sections it holds, the shared save bar, and the admin-only guard. */
export function SettingsScreen({ slug }: { slug: SettingsPageSlug }) {
    const page = settingsPage(slug);
    const router = useRouter();
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const {
        isAdmin,
        loadError,
        isLoaded,
        isDirty,
        isSaving,
        saveStatus,
        retryLoad,
        handleSaveAll,
        handleTestService,
        testingServices,
        userSettings,
        updateUserSettings,
        systemSettings,
        updateSystemSettings,
    } = useSettingsState();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const hasPhoneChrome = isMobile || isTablet;
    const { currentTrack, currentAudiobook, currentPodcast } = useAudioState();
    const hasMiniPlayer = !!(currentTrack || currentAudiobook || currentPodcast);

    // An admin page is an admin's; anyone else lands on their own.
    useEffect(() => {
        if (!authLoading && isAuthenticated && page.adminOnly && !isAdmin) router.replace("/settings");
    }, [authLoading, isAuthenticated, page.adminOnly, isAdmin, router]);

    // A link to a section scrolls there once the page's sections have loaded.
    useEffect(() => {
        if (typeof window !== "undefined") {
            const hash = window.location.hash.substring(1);
            // Links from before settings had pages (/settings#lidarr) go to the page that holds the section.
            const moved = slug === "you" && hash ? addressForOldSection(hash) : undefined;
            if (moved) {
                router.replace(moved);
                return;
            }
            if (hash && isLoaded) {
                setTimeout(() => {
                    const element = document.getElementById(hash);
                    if (element) {
                        element.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                }, 100);
            }
        }
    }, [slug, router, isLoaded]);

    if (authLoading) {
        return <LoadingScreen />;
    }

    if (!isAuthenticated || (page.adminOnly && !isAdmin)) {
        return null;
    }

    if (loadError) {
        return (
            <SettingsLayout page={page} isAdmin={isAdmin}>
                <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-6">
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                        Settings could not be loaded
                    </h2>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">{loadError}</p>
                    <Button
                        variant="primary"
                        onClick={retryLoad}
                        className="mt-4"
                    >
                        Try again
                    </Button>
                </div>
            </SettingsLayout>
        );
    }

    if (!isLoaded) {
        return (
            <SettingsLayout page={page} isAdmin={isAdmin}>
                <div className="flex justify-center py-24" aria-busy="true">
                    <GradientSpinner size="md" />
                </div>
            </SettingsLayout>
        );
    }

    const sections: Record<SettingsPageSlug, ReactNode> = {
        you: (
            <>
                <AccountSection />
                <SubsonicSection />
                <PlaybackSection
                    value={userSettings.playbackQuality}
                    onChange={(quality) => updateUserSettings({ playbackQuality: quality })}
                    // Server-wide, so the row only appears for an admin. Passing
                    // no handler is what hides it.
                    maxQueueLength={isAdmin ? systemSettings.maxQueueLength : undefined}
                    onMaxQueueLength={
                        isAdmin
                            ? (maxQueueLength) => updateSystemSettings({ maxQueueLength })
                            : undefined
                    }
                />
                <ScrobblingSection
                    configured={!!userSettings.hasListenbrainzToken}
                    onSaved={(hasListenbrainzToken) => updateUserSettings({ hasListenbrainzToken })}
                    liveSharing={
                        userSettings.liveSharingAvailable
                            ? {
                                  checked: userSettings.shareLiveListening !== false,
                                  onChange: (shareLiveListening) => updateUserSettings({ shareLiveListening }),
                              }
                            : undefined
                    }
                />
            </>
        ),
        library: (
            <CacheSection settings={systemSettings} onUpdate={updateSystemSettings}>
                <CorruptTracksSection />
            </CacheSection>
        ),
        sources: (
            <>
                <DownloadPreferencesSection settings={systemSettings} onUpdate={updateSystemSettings} />
                <LidarrSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    isTesting={testingServices.lidarr || false}
                />
                <SoulseekSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    isTesting={testingServices.soulseek || false}
                />
                <AudiobookshelfSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    isTesting={testingServices.audiobookshelf || false}
                />
                <PodcastsSection settings={systemSettings} onUpdate={updateSystemSettings} />
            </>
        ),
        server: (
            <>
                <StoragePathsSection settings={systemSettings} onUpdate={updateSystemSettings} />
                <ArtworkSection
                    settings={systemSettings}
                    onUpdate={updateSystemSettings}
                    onTest={handleTestService}
                    isTesting={testingServices.fanart || false}
                />
            </>
        ),
        people: <UserManagementSection settings={systemSettings} onUpdate={updateSystemSettings} />,
    };

    return (
        <SettingsLayout page={page} isAdmin={isAdmin}>
            <div className="section-stack">{sections[slug]}</div>

            {(isDirty || saveStatus.props.status !== "idle") && (
                <div
                    className={cn(
                        "sticky z-(--z-raised) mt-8 flex items-center justify-end gap-4 rounded-lg border border-white/10 bg-[#111] px-4 py-3",
                        (!hasPhoneChrome || !hasMiniPlayer) && "bottom-4",
                        hasPhoneChrome && hasMiniPlayer && "bottom-[94px]",
                    )}
                >
                    <InlineStatus {...saveStatus.props} />
                    {isDirty && (
                        <>
                            <span className="mr-auto text-sm text-[var(--text-secondary)]">Unsaved changes</span>
                            <Button variant="primary" onClick={handleSaveAll} disabled={isSaving}>
                                {isSaving ? "Saving..." : "Save changes"}
                            </Button>
                        </>
                    )}
                </div>
            )}
        </SettingsLayout>
    );
}
