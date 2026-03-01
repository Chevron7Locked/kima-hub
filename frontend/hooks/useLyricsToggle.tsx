"use client";

import { useCallback, useState } from "react";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { useAudioState } from "@/lib/audio-state-context";
import { LyricsPanel } from "@/components/lyrics/LyricsPanel";

interface UseLyricsToggleOptions {
    isMobile: boolean;
}

export function useLyricsToggle({ isMobile }: UseLyricsToggleOptions) {
    const { setSettingsContent, settingsOwner } = useActivityPanelSettings();
    const { currentTrack } = useAudioState();

    // Mobile: local toggle state for inline crawl. Desktop: activity panel.
    const [mobileActive, setMobileActive] = useState(false);

    // Render-time reset on track change (avoids setState-in-effect lint rule)
    const [prevTrackId, setPrevTrackId] = useState(currentTrack?.id);
    if (currentTrack?.id !== prevTrackId) {
        setPrevTrackId(currentTrack?.id);
        setMobileActive(false);
    }

    const isLyricsActive = isMobile ? mobileActive : settingsOwner === "lyrics";

    const closeLyrics = useCallback(() => {
        setSettingsContent(null);
        window.dispatchEvent(
            new CustomEvent("set-activity-panel-tab", {
                detail: { tab: "active" },
            })
        );
    }, [setSettingsContent]);

    const handleLyricsToggle = useCallback(() => {
        if (isMobile) {
            setMobileActive(prev => !prev);
            return;
        }

        if (settingsOwner === "lyrics") {
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
    }, [setSettingsContent, closeLyrics, settingsOwner, isMobile]);

    return { handleLyricsToggle, isLyricsActive };
}
