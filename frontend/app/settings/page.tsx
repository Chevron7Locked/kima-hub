"use client";

import { useEffect, useState, useCallback } from "react";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { useAudioState } from "@/lib/audio-context";
import { useAuth } from "@/lib/auth-context";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { useSystemSettings } from "@/features/settings/hooks/useSystemSettings";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { InlineStatus, useInlineStatus } from "@/components/ui/InlineStatus";
import {
    SettingsLayout,
    SidebarItem
} from "@/features/settings/components/ui";

import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { SubsonicSection } from "@/features/settings/components/sections/SubsonicSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { ScrobblingSection } from "@/features/settings/components/sections/ScrobblingSection";
import { DownloadPreferencesSection } from "@/features/settings/components/sections/DownloadPreferencesSection";
import { LidarrSection } from "@/features/settings/components/sections/LidarrSection";
import { AudiobookshelfSection } from "@/features/settings/components/sections/AudiobookshelfSection";
import { SoulseekSection } from "@/features/settings/components/sections/SoulseekSection";
import { ArtworkSection } from "@/features/settings/components/sections/ArtworkSection";
import { StoragePathsSection } from "@/features/settings/components/sections/StoragePathsSection";
import { CacheSection } from "@/features/settings/components/sections/CacheSection";
import { UserManagementSection } from "@/features/settings/components/sections/UserManagementSection";
import { CorruptTracksSection } from "@/features/settings/components/sections/CorruptTracksSection";
import { Button } from "@/components/ui/Button";

const sidebarItems: SidebarItem[] = [
    { id: "account", label: "Account" },
    { id: "subsonic", label: "Native Apps" },
    { id: "playback", label: "Playback" },
    { id: "scrobbling", label: "Scrobbling" },
    { id: "download-preferences", label: "Download Preferences", adminOnly: true },
    { id: "lidarr", label: "Download Services", adminOnly: true },
    { id: "audiobookshelf", label: "Media Servers", adminOnly: true },
    { id: "soulseek", label: "P2P Networks", adminOnly: true },
    { id: "artwork", label: "Artwork", adminOnly: true },
    { id: "storage", label: "Storage", adminOnly: true },
    { id: "cache", label: "Library Enrichment", adminOnly: true },
    { id: "corrupt-tracks", label: "Corrupt Tracks", adminOnly: true },
    { id: "users", label: "Users", adminOnly: true },
];

export default function SettingsPage() {
    const { isAuthenticated, isLoading: authLoading, user } = useAuth();
    const [isSaving, setIsSaving] = useState(false);
    const [testingServices, setTestingServices] = useState<Record<string, boolean>>({});
    const saveStatus = useInlineStatus();

    const isAdmin = user?.role === "admin";

    const {
        settings: userSettings,
        isLoading: userLoading,
        loadError: userLoadError,
        updateSettings: updateUserSettings,
        saveSettings: saveUserSettings,
        loadSettings: reloadUserSettings,
    } = useSettingsData();

    const {
        systemSettings,
        isLoading: systemLoading,
        loadError: systemLoadError,
        updateSystemSettings,
        saveSystemSettings,
        testService,
        loadSystemSettings,
    } = useSystemSettings();

    const loadError = userLoadError ?? (isAdmin ? systemLoadError : null);
    const isLoaded = !userLoading && (!isAdmin || !systemLoading);

    // The token is saved on its own, so only the editable settings count as unsaved.
    const snapshot = useCallback(
        ({ hasListenbrainzToken: _token, ...editable }: typeof userSettings) =>
            JSON.stringify([editable, isAdmin ? systemSettings : null]),
        [isAdmin, systemSettings],
    );
    const current = isLoaded && !loadError ? snapshot(userSettings) : null;
    const [saved, setSaved] = useState<string | null>(null);
    if (current !== null && saved === null) setSaved(current);
    const isDirty = current !== null && saved !== null && current !== saved;
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const hasPhoneChrome = isMobile || isTablet;
    const { currentTrack, currentAudiobook, currentPodcast } = useAudioState();
    const hasMiniPlayer = !!(currentTrack || currentAudiobook || currentPodcast);

    const retryLoad = useCallback(() => {
        setSaved(null);
        reloadUserSettings();
        if (isAdmin) loadSystemSettings();
    }, [isAdmin, reloadUserSettings, loadSystemSettings]);

    useEffect(() => {
        if (typeof window !== "undefined") {
            const hash = window.location.hash.substring(1);
            if (hash) {
                setTimeout(() => {
                    const element = document.getElementById(hash);
                    if (element) {
                        element.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                }, 100);
            }
        }
    }, []);

    const handleSaveAll = useCallback(async () => {
        setIsSaving(true);
        saveStatus.setLoading();
        let hasError = false;

        try {
            await saveUserSettings(userSettings);
        } catch (error) {
            console.error("Failed to save user settings:", error);
            hasError = true;
        }

        if (isAdmin) {
            try {
                await saveSystemSettings(systemSettings);
            } catch (error) {
                console.error("Failed to save system settings:", error);
                hasError = true;
            }
        }

        setIsSaving(false);

        if (hasError) {
            saveStatus.setError("Couldn't save");
        } else {
            setSaved(snapshot(userSettings));
            saveStatus.setSuccess("Saved");
        }
    }, [userSettings, systemSettings, isAdmin, saveUserSettings, saveSystemSettings, saveStatus, snapshot]);

    const handleTestService = useCallback(async (service: string) => {
        setTestingServices(prev => ({ ...prev, [service]: true }));
        try {
            return await testService(service);
        } finally {
            setTestingServices(prev => ({ ...prev, [service]: false }));
        }
    }, [testService]);

    if (authLoading) {
        return <LoadingScreen />;
    }

    if (!isAuthenticated) {
        return null;
    }

    if (loadError) {
        return (
            <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
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
            <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
                <div className="flex justify-center py-24" aria-busy="true">
                    <GradientSpinner size="md" />
                </div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
            <div className="section-stack">
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

                {isAdmin && (
                    <>
                        <DownloadPreferencesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        <LidarrSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.lidarr || false}
                        />

                        <AudiobookshelfSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.audiobookshelf || false}
                        />

                        <SoulseekSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.soulseek || false}
                        />

                        <ArtworkSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.fanart || false}
                        />

                        <StoragePathsSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        <CacheSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        <CorruptTracksSection />

                        <UserManagementSection />
                    </>
                )}
            </div>

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
