"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { useInlineStatus } from "@/components/ui/InlineStatus";
import { useSettingsData } from "./hooks/useSettingsData";
import { useSystemSettings } from "./hooks/useSystemSettings";

/**
 * Settings data for all five pages, held above them so an edit not yet saved survives moving between pages; the
 * save bar on any page saves every edit.
 */
function useSettingsStateValue() {
    const { user, isAuthenticated } = useAuth();
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
    // Another person, or a changed role, starts from what the server holds for them, not from the last one's.
    const identity = `${isAuthenticated ? (user?.id ?? "") : ""}:${isAdmin}`;
    const identityRef = useRef(identity);
    useLayoutEffect(() => {
        identityRef.current = identity;
    });
    const [savedFor, setSavedFor] = useState(identity);
    if (savedFor !== identity) {
        setSavedFor(identity);
        setSaved(null);
    } else if (current !== null && saved === null) setSaved(current);
    const isDirty = current !== null && saved !== null && current !== saved;
    const retryLoad = useCallback(() => {
        setSaved(null);
        reloadUserSettings();
        if (isAdmin) loadSystemSettings();
    }, [isAdmin, reloadUserSettings, loadSystemSettings]);

    // A role change keeps the same person's loaded settings, edits included, so read them again from the server.
    const roleOf = useRef(identity);
    useEffect(() => {
        const [was, is] = [roleOf.current, identity];
        roleOf.current = identity;
        if (was !== is && was.split(":")[0] === is.split(":")[0] && is.split(":")[0] !== "") retryLoad();
    }, [identity, retryLoad]);

    const handleSaveAll = useCallback(async () => {
        const savingFor = identityRef.current;
        setIsSaving(true);
        saveStatus.setLoading();
        let hasError = false;
        let reason: string | null = null;

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
                // The server says what it refused (a music folder that does not exist, say).
                reason = error instanceof Error ? error.message : null;
            }
        }

        setIsSaving(false);

        if (hasError) {
            saveStatus.setError(reason ? `Couldn't save: ${reason.toLowerCase()}` : "Couldn't save");
        } else {
            // A save that finishes after someone else signed in must not become their baseline.
            if (identityRef.current === savingFor) setSaved(snapshot(userSettings));
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

    return {
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
    };
}

type SettingsState = ReturnType<typeof useSettingsStateValue>;
const SettingsStateContext = createContext<SettingsState | null>(null);

export function SettingsStateProvider({ children }: { children: ReactNode }) {
    return <SettingsStateContext.Provider value={useSettingsStateValue()}>{children}</SettingsStateContext.Provider>;
}

export function useSettingsState(): SettingsState {
    const state = useContext(SettingsStateContext);
    if (!state) throw new Error("useSettingsState needs SettingsStateProvider (app/settings/layout.tsx)");
    return state;
}
