"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface ActivityPanelSettingsContextType {
    settingsContent: ReactNode | null;
    settingsOwner: string | null;
    setSettingsContent: (content: ReactNode | null, owner?: string | null) => void;
}

const ActivityPanelSettingsContext = createContext<ActivityPanelSettingsContextType | undefined>(
    undefined
);

export function ActivityPanelSettingsProvider({ children }: { children: ReactNode }) {
    const [settingsContent, setContent] = useState<ReactNode | null>(null);
    const [settingsOwner, setOwner] = useState<string | null>(null);

    const setSettingsContent = useCallback((content: ReactNode | null, owner: string | null = null) => {
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
