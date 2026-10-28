"use client";

import { useCallback, useState } from "react";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { useAudioState } from "@/lib/audio-state-context";
import { leaveActivityPanelSettings, openActivityPanel } from "@/hooks/useActivityPanel";
import { LyricsPanel } from "@/components/lyrics/LyricsPanel";

interface UseLyricsToggleOptions {
    /** Lyrics replace the artwork in place instead of opening in the activity panel. */
    inline: boolean;
}

export function useLyricsToggle({ inline }: UseLyricsToggleOptions) {
    const { setSettingsContent, settingsOwner } = useActivityPanelSettings();
    const { currentTrack } = useAudioState();

    const [inlineActive, setInlineActive] = useState(false);

    // Render-time reset on track change (avoids setState-in-effect lint rule)
    const [prevTrackId, setPrevTrackId] = useState(currentTrack?.id);
    if (currentTrack?.id !== prevTrackId) {
        setPrevTrackId(currentTrack?.id);
        setInlineActive(false);
    }

    const isLyricsActive = inline ? inlineActive : settingsOwner === "lyrics";

    const closeLyrics = useCallback(() => {
        setSettingsContent(null);
        leaveActivityPanelSettings();
    }, [setSettingsContent]);

    const handleLyricsToggle = useCallback(() => {
        if (inline) {
            setInlineActive(prev => !prev);
            return;
        }

        if (settingsOwner === "lyrics") {
            closeLyrics();
            return;
        }

        setSettingsContent(<LyricsPanel onBack={closeLyrics} />, "lyrics");
        openActivityPanel("settings");
    }, [setSettingsContent, closeLyrics, settingsOwner, inline]);

    return { handleLyricsToggle, isLyricsActive };
}
