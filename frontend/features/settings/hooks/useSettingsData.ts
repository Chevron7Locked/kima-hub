import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { UserSettings } from "../types";

const defaultSettings: UserSettings = {
    playbackQuality: "original",
    wifiOnly: false,
    offlineEnabled: false,
    maxCacheSizeMb: 5120,
};

export function useSettingsData() {
    const { isAuthenticated } = useAuth();
    const [settings, setSettings] = useState<UserSettings>(defaultSettings);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (isAuthenticated) {
            loadSettings();
        }
    }, [isAuthenticated]);

    const loadSettings = async () => {
        try {
            setIsLoading(true);
            setLoadError(null);
            const data = await api.getSettings();
            setSettings(data);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "Failed to load settings");
        } finally {
            setIsLoading(false);
        }
    };

    const saveSettings = async (newSettings: UserSettings) => {
        try {
            setIsSaving(true);
            await api.updateSettings(newSettings);
            setSettings(newSettings);
        } catch (error) {
            console.error("Failed to save settings:", error);
            throw error;
        } finally {
            setIsSaving(false);
        }
    };

    const updateSettings = (updates: Partial<UserSettings>) => {
        setSettings((prev) => ({ ...prev, ...updates }));
    };

    return {
        settings,
        isLoading,
        loadError,
        isSaving,
        setSettings,
        updateSettings,
        saveSettings,
        loadSettings,
    };
}
