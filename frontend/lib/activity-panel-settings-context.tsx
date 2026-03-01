"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

export type SettingsOwner = "lyrics" | "discover" | null;

interface ActivityPanelSettingsContextType {
    settingsContent: ReactNode | null;
    settingsOwner: SettingsOwner;
    setSettingsContent: (content: ReactNode | null, owner?: SettingsOwner) => void;
}

const ActivityPanelSettingsContext = createContext<ActivityPanelSettingsContextType | undefined>(
    undefined
);

export function ActivityPanelSettingsProvider({ children }: { children: ReactNode }) {
    const [settingsContent, setContent] = useState<ReactNode | null>(null);
    const [settingsOwner, setOwner] = useState<SettingsOwner>(null);

    const setSettingsContent = useCallback((content: ReactNode | null, owner: SettingsOwner = null) => {
        setContent(content);
        setOwner(content ? owner : null);
    }, []);

    return (
        <ActivityPanelSettingsContext.Provider value={{ settingsContent, settingsOwner, setSettingsContent }}>
            {children}
        </ActivityPanelSettingsContext.Provider>
    );
}

export function useActivityPanelSettings() {
    const context = useContext(ActivityPanelSettingsContext);
    if (!context) {
        throw new Error(
            "useActivityPanelSettings must be used within ActivityPanelSettingsProvider"
        );
    }
    return context;
}
