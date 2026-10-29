import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { UserSettings } from "../types";

const defaultSettings: UserSettings = {
    playbackQuality: "original",
    wifiOnly: false,
};

export function useSettingsData() {
    const { isAuthenticated, user } = useAuth();
    // The settings belong to whoever is signed in; a different person starts from the defaults.
    const userId = isAuthenticated ? (user?.id ?? null) : null;
    const [settings, setSettings] = useState<UserSettings>(defaultSettings);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    // An answer that arrives after someone else signed in is dropped.
    const currentUserRef = useRef(userId);
    useLayoutEffect(() => {
        currentUserRef.current = userId;
    }, [userId]);

    const fetchSettings = useCallback(() => {
        const askedFor = userId;
        const current = () => currentUserRef.current === askedFor;
        return api
            .getSettings()
            .then((loaded) => {
                if (current()) setSettings(loaded);
            })
            .catch((error) => {
                if (current()) setLoadError(error instanceof Error ? error.message : "Failed to load settings");
            })
            .finally(() => {
                if (current()) setIsLoading(false);
            });
    }, [userId]);

    const loadSettings = () => {
        setIsLoading(true);
        setLoadError(null);
        return fetchSettings();
    };

    const [shownFor, setShownFor] = useState(userId);
    if (shownFor !== userId) {
        setShownFor(userId);
        setSettings(defaultSettings);
        setIsLoading(true);
        setLoadError(null);
    }

    useEffect(() => {
        if (userId) {
            fetchSettings();
        }
    }, [userId, fetchSettings]);

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
