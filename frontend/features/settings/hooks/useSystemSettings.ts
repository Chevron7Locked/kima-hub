import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { ConnectionTestResult, SystemSettings } from "../types";

const defaultSystemSettings: SystemSettings = {
    lidarrEnabled: true,
    lidarrUrl: "http://localhost:8686",
    lidarrApiKey: "",
    fanartEnabled: false,
    fanartApiKey: "",
    acoustidApiKey: "",
    audiobookshelfEnabled: false,
    audiobookshelfUrl: "http://localhost:13378",
    audiobookshelfApiKey: "",
    soulseekUsername: "",
    soulseekPassword: "",
    soulseekMode: "p2p",
    slskdUrl: "",
    slskdApiKey: "",
    spotifyClientId: "",
    spotifyClientSecret: "",
    musicPath: "/music",
    downloadPath: "/downloads",
    transcodeCacheMaxGb: 10,
    maxQueueLength: 10000,
    maxCacheSizeMb: 10240,
    autoSync: true,
    autoEnrichMetadata: true,
    soulseekConcurrentDownloads: 4,
    lidarrQualityProfileId: null,
    lidarrMetadataProfileId: null,
    lidarrRemoveJunk: true,
    // Download preferences
    downloadSource: "soulseek",
    primaryFailureFallback: "none",
    // AI playlist generation (#240, Manual Mode) — off by default. Values are
    // overwritten by the server once loaded; these only seed the pre-load
    // render and the shape of the SystemSettings type.
    aiPlaylistEnabled: false,
    aiProvider: "openai",
    aiApiBaseUrl: null,
    aiModel: null,
    aiApiKey: null,
    aiMaxPlaylistSize: 100,
    aiBlockedGenres: [],
    aiBlockedArtists: [],
    // Server
    publicUrl: "",
};

export function useSystemSettings() {
    const { isAuthenticated, user } = useAuth();
    const [systemSettings, setSystemSettings] = useState<SystemSettings>(
        defaultSystemSettings
    );
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const isAdmin = user?.role === "admin";

    useEffect(() => {
        if (isAuthenticated && isAdmin) {
            loadSystemSettings();
        }
    }, [isAuthenticated, isAdmin]);

    const loadSystemSettings = async () => {
        try {
            setIsLoading(true);
            setLoadError(null);
            const [sysData, userData] = await Promise.all([
                api.getSystemSettings(),
                api.getSettings(),
            ]);

            // Null strings become empty strings for controlled inputs.
            const sanitizeSettings = (settings: Record<string, unknown>): SystemSettings => {
                const sanitized: Record<string, unknown> = {};
                for (const key in settings) {
                    const value = settings[key];
                    if (value === null && typeof defaultSystemSettings[key as keyof SystemSettings] === 'string') {
                        sanitized[key] = '';
                    } else {
                        sanitized[key] = value;
                    }
                }
                return sanitized as unknown as SystemSettings;
            };

            const combinedSettings = {
                ...sanitizeSettings(sysData),
                maxCacheSizeMb: userData.maxCacheSizeMb,
            };

            setSystemSettings(combinedSettings);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "Failed to load settings");
        } finally {
            setIsLoading(false);
        }
    };

    const saveSystemSettings = async (settingsToSave: SystemSettings) => {
        await api.updateSystemSettings(settingsToSave);
        await api.updateSettings({ maxCacheSizeMb: settingsToSave.maxCacheSizeMb });
    };

    const updateSystemSettings = (updates: Partial<SystemSettings>) => {
        setSystemSettings((prev) => ({ ...prev, ...updates }));
    };

    /** Tests a service connection; the caller shows the result. */
    const testService = async (service: string): Promise<ConnectionTestResult> => {
        try {
            let result;
            switch (service) {
                case "lidarr":
                    result = await api.testLidarr(
                        systemSettings.lidarrUrl,
                        systemSettings.lidarrApiKey
                    );
                    break;
                case "fanart":
                    result = await api.testFanart(systemSettings.fanartApiKey);
                    break;
                case "audiobookshelf":
                    result = await api.testAudiobookshelf(
                        systemSettings.audiobookshelfUrl,
                        systemSettings.audiobookshelfApiKey
                    );
                    break;
                case "soulseek":
                    result = await api.testSoulseek({
                        mode: systemSettings.soulseekMode === "slskd" ? "slskd" : "p2p",
                        username: systemSettings.soulseekUsername,
                        password: systemSettings.soulseekPassword,
                        slskdUrl: systemSettings.slskdUrl ?? undefined,
                        slskdApiKey: systemSettings.slskdApiKey ?? undefined,
                    });
                    break;
                case "ai": {
                    // Test the candidate values currently in the form — never
                    // the saved credentials — so a key can be validated before
                    // it is persisted (#240, Manual Mode).
                    const aiKey = systemSettings.aiApiKey ?? undefined;
                    result = await api.testAIProvider({
                        provider:
                            systemSettings.aiProvider === "openai"
                                ? "openai"
                                : "openai_compatible",
                        apiBaseUrl: systemSettings.aiApiBaseUrl ?? undefined,
                        model: systemSettings.aiModel ?? undefined,
                        apiKey: aiKey,
                    });
                    break;
                }
                default:
                    throw new Error(`Unknown service: ${service}`);
            }

            return { success: true, version: result?.version };
        } catch (error: unknown) {
            console.error(`Failed to test ${service}:`, error);
            return { success: false, error: error instanceof Error ? error.message : `Failed to connect` };
        }
    };

    return {
        systemSettings,
        isLoading,
        loadError,
        updateSystemSettings,
        saveSystemSettings,
        testService,
        loadSystemSettings,
    };
}
