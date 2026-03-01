"use client";

import { useCallback } from "react";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { LyricsPanel } from "@/components/lyrics/LyricsPanel";

interface UseLyricsToggleOptions {
    onMobileToggle?: () => void;
}

export function useLyricsToggle({ onMobileToggle }: UseLyricsToggleOptions = {}) {
    const { setSettingsContent, settingsOwner } = useActivityPanelSettings();
    const isLyricsOpen = settingsOwner === "lyrics";

    const closeLyrics = useCallback(() => {
        setSettingsContent(null);
        window.dispatchEvent(
            new CustomEvent("set-activity-panel-tab", {
                detail: { tab: "active" },
            })
        );
    }, [setSettingsContent]);

    const handleLyricsToggle = useCallback(() => {
        if (onMobileToggle) {
            onMobileToggle();
            return;
        }

        if (isLyricsOpen) {
            closeLyrics();
            return;
        }

        setSettingsContent(<LyricsPanel onBack={closeLyrics} />, "lyrics");
        window.dispatchEvent(new CustomEvent("open-activity-panel"));
        window.dispatchEvent(
            new CustomEvent("set-activity-panel-tab", {
                detail: { tab: "settings" },
            })
        );
    }, [setSettingsContent, closeLyrics, onMobileToggle, isLyricsOpen]);

    return { handleLyricsToggle, isLyricsOpen };
}
