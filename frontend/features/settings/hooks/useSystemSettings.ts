import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { ConnectionTestResult, SystemSettings } from "../types";

const defaultSystemSettings: SystemSettings = {
    lidarrEnabled: true,
    allowMemberAcquire: false,
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
    musicPath: "/music",
    downloadPath: "/downloads",
    transcodeCacheMaxGb: 10,
    maxQueueLength: 10000,
    autoSync: true,
    soulseekConcurrentDownloads: 4,
    lidarrQualityProfileId: null,
    lidarrMetadataProfileId: null,
    lidarrRemoveJunk: true,
    // Download preferences
    downloadSource: "soulseek",
    primaryFailureFallback: "none",
    // Server
    publicUrl: "",
    updateChecksEnabled: true,
    podcastChartCountry: "us",
};

export function useSystemSettings() {
    const { isAuthenticated, user } = useAuth();
    const [systemSettings, setSystemSettings] = useState<SystemSettings>(
        defaultSystemSettings
    );
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const isAdmin = user?.role === "admin";
    // Loaded for the signed-in admin; a different person starts from the defaults.
    const adminId = isAuthenticated && isAdmin ? (user?.id ?? null) : null;

    // An answer that arrives after someone else signed in is dropped.
    const currentAdminRef = useRef(adminId);
    useLayoutEffect(() => {
        currentAdminRef.current = adminId;
    }, [adminId]);

    const fetchSystemSettings = useCallback(() => {
        const askedFor = adminId;
        const current = () => currentAdminRef.current === askedFor;
        return api.getSystemSettings()
            .then((sysData) => {
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

                if (current()) setSystemSettings(sanitizeSettings(sysData));
            })
            .catch((error) => {
                if (current()) setLoadError(error instanceof Error ? error.message : "Failed to load settings");
            })
            .finally(() => {
                if (current()) setIsLoading(false);
            });
    }, [adminId]);

    const loadSystemSettings = () => {
        setIsLoading(true);
        setLoadError(null);
        return fetchSystemSettings();
    };

    const [shownFor, setShownFor] = useState(adminId);
    if (shownFor !== adminId) {
        setShownFor(adminId);
        setSystemSettings(defaultSystemSettings);
        setIsLoading(true);
        setLoadError(null);
    }

    useEffect(() => {
        if (adminId) {
            fetchSystemSettings();
        }
    }, [adminId, fetchSystemSettings]);

    const saveSystemSettings = async (settingsToSave: SystemSettings) => {
        await api.updateSystemSettings(settingsToSave);
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
