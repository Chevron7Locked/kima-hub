"use client";

import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useNotifications, useActiveDownloads } from "@/hooks/useNotifications";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { useAudioState } from "@/lib/audio-state-context";
import type { ActivityType } from "@/features/vibe/ActivityIconBar";
import { ActivityContent } from "@/features/vibe/panel-shared";
import { QueueTab } from "@/features/vibe/tabs/QueueTab";
import { ArtistAbout, NowPlayingStrip } from "@/features/vibe/tabs/NowPlayingTab";
import { LyricsView } from "@/components/lyrics/LyricsView";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { PanelHeading, PanelOptions, panelIconButton, panelTabId } from "./panelChrome";

interface UnifiedPanelProps {
    isOpen: boolean;
    onToggle: () => void;
}

type Listening = "up-next" | "lyrics" | "about";
type Activity = "all" | ActivityType;

const OPEN_WIDTH = 380;
const CLOSED_WIDTH = 16;

/** The tab names the rest of the app opens the panel on, as this panel's activity options. */
const FROM_APP_TAB: Record<string, Activity> = {
    all: "all",
    notifications: "notifications",
    active: "downloads",
    imports: "imports",
    history: "history",
};

/**
 * The desktop panel on the right, in two halves with one grammar, the same as the left library panel's: listening
 * above (the playing song, then what is next, its lyrics or its artist) and activity below (everything Kima is doing,
 * or one kind of it). Pages can hand it settings to show instead (Discover's, the lyrics'), which take the panel whole.
 */
export function UnifiedPanel({ isOpen, onToggle }: UnifiedPanelProps) {
    const [listening, setListening] = useState<Listening>("up-next");
    const [activity, setActivity] = useState<Activity>("all");
    // Externally-registered settings content (discover settings gear, lyrics).
    // Pages register it via useActivityPanelSettings and open it by dispatching
    // "set-activity-panel-tab" { tab: "settings" }; this panel renders it.
    const [showSettings, setShowSettings] = useState(false);
    const { settingsContent } = useActivityPanelSettings();
    const { unreadCount } = useNotifications();
    const { downloads: activeDownloads } = useActiveDownloads();
    const { queue, currentIndex } = useAudioState();
    const hasActivity = unreadCount > 0 || activeDownloads.length > 0;
    const upNext = Math.max(0, queue.length - currentIndex - 1);

    // Focus follows the panel, as it does for the left library: closing lands on the handle that reopens it, and
    // reopening lands on the control that closes it, so a keyboard is never left on content that went inert.
    // The move happens once React has applied the change (the handle tabbable, the content no longer inert), not on
    // an animation frame, which a busy page can hold back.
    const handleRef = useRef<HTMLButtonElement>(null);
    const hideRef = useRef<HTMLButtonElement>(null);
    const focusAfterToggle = useRef(false);
    useLayoutEffect(() => {
        if (!focusAfterToggle.current) return;
        focusAfterToggle.current = false;
        (isOpen ? hideRef : handleRef).current?.focus();
    }, [isOpen]);
    // Reset settings view on collapse so reopening shows the halves.
    const handleCollapse = () => {
        setShowSettings(false);
        focusAfterToggle.current = true;
        onToggle();
    };

    // The rest of the app opens the panel on a tab: settings take the panel, the others pick the activity option.
    useEffect(() => {
        const handleSetTab = (e: Event) => {
            const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
            if (tab === "settings") {
                setShowSettings(true);
                return;
            }
            setShowSettings(false);
            if (tab && FROM_APP_TAB[tab]) setActivity(FROM_APP_TAB[tab]);
        };
        // Leaving a page's settings returns to the halves as they were.
        const handleLeave = () => setShowSettings(false);
        window.addEventListener("set-activity-panel-tab", handleSetTab);
        window.addEventListener("leave-activity-panel-settings", handleLeave);
        return () => {
            window.removeEventListener("set-activity-panel-tab", handleSetTab);
            window.removeEventListener("leave-activity-panel-settings", handleLeave);
        };
    }, []);

    // settingsContent null (owner page unmounted) falls through to the halves
    // via the `settingsContent &&` render guard -- no reset effect needed.
    const settingsActive = showSettings && !!settingsContent;

    return (
        <div className="shrink-0 h-full relative z-(--z-raised)" style={{ width: isOpen ? OPEN_WIDTH : CLOSED_WIDTH }}>
            <aside
                id="activity-panel"
                aria-label="listening and activity"
                className="absolute inset-y-0 right-0 flex flex-col overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] transition-transform duration-300 ease-[cubic-bezier(0.25,1,0.5,1)]"
                style={{
                    width: OPEN_WIDTH,
                    transform: isOpen ? "translateX(0)" : `translateX(${OPEN_WIDTH - CLOSED_WIDTH}px)`,
                    willChange: "transform",
                }}
            >
                {/* Closed, the panel is a handle, like the left library's. */}
                <button
                    ref={handleRef}
                    type="button"
                    onClick={handleCollapse}
                    tabIndex={isOpen ? -1 : undefined}
                    aria-hidden={isOpen || undefined}
                    aria-label="open panel"
                    title="open panel"
                    className={cn(
                        "group absolute inset-y-0 left-0 z-(--z-raised) flex w-4 flex-col items-center pt-3 outline-none transition-colors duration-150 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60",
                        isOpen && "pointer-events-none opacity-0",
                    )}
                >
                    <ChevronLeft
                        aria-hidden="true"
                        className="h-3.5 w-3.5 text-[var(--text-muted)] transition-colors duration-150 group-hover:text-brand"
                    />
                    {hasActivity && <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 rounded-full bg-brand" />}
                </button>

                {/* Expanded content; inert while collapsed so its controls can't take focus. */}
                <div
                    inert={!isOpen}
                    className={cn(
                        "flex h-full min-h-0 flex-col transition-opacity duration-300",
                        isOpen ? "opacity-100" : "pointer-events-none opacity-0",
                    )}
                >
                    {settingsActive ? (
                        // Externally-registered settings (discover gear / lyrics).
                        // The content provides its own header and back button,
                        // which calls leaveActivityPanelSettings to exit.
                        <div className="flex-1 min-h-0 overflow-hidden">{settingsContent}</div>
                    ) : (
                        <>
                            <section aria-label="listening" className="flex min-h-0 flex-1 flex-col">
                                <PanelHeading
                                    label="listening"
                                    actions={
                                        <button
                                            ref={hideRef}
                                            type="button"
                                            onClick={handleCollapse}
                                            aria-label="hide panel"
                                            title="hide panel"
                                            className={panelIconButton}
                                        >
                                            <ChevronRight aria-hidden="true" className="h-4 w-4" />
                                        </button>
                                    }
                                />
                                <NowPlayingStrip />
                                <PanelOptions<Listening>
                                    label="listening"
                                    controls="panel-listening"
                                    value={listening}
                                    onChange={setListening}
                                    options={[
                                        { key: "up-next", label: "up next", count: upNext },
                                        { key: "lyrics", label: "lyrics" },
                                        { key: "about", label: "about" },
                                    ]}
                                />
                                <div
                                    id="panel-listening"
                                    role="tabpanel"
                                    aria-labelledby={panelTabId("panel-listening", listening)}
                                    className="flex min-h-0 flex-1 flex-col overflow-hidden">
                                    {listening === "up-next" && <QueueTab withNowPlaying={false} />}
                                    {listening === "lyrics" && <LyricsView variant="panel" />}
                                    {listening === "about" && (
                                        <div className="flex-1 overflow-y-auto">
                                            <ArtistAbout />
                                        </div>
                                    )}
                                </div>
                            </section>

                            <section aria-label="activity" className="flex min-h-0 flex-1 flex-col border-t border-white/[0.06]">
                                <PanelHeading label="activity" />
                                <PanelOptions<Activity>
                                    label="activity"
                                    controls="panel-activity"
                                    value={activity}
                                    onChange={setActivity}
                                    options={[
                                        { key: "all", label: "all" },
                                        { key: "notifications", label: "alerts", count: unreadCount, urgent: true },
                                        { key: "downloads", label: "downloads", count: activeDownloads.length, urgent: true },
                                        { key: "imports", label: "imports" },
                                        { key: "history", label: "history" },
                                    ]}
                                />
                                <div
                                    id="panel-activity"
                                    role="tabpanel"
                                    aria-labelledby={panelTabId("panel-activity", activity)}
                                    className="min-h-0 flex-1 overflow-y-auto">
                                    {activity === "all" ? (
                                        <ActivityFeed onOpen={setActivity} />
                                    ) : (
                                        <ActivityContent type={activity} />
                                    )}
                                </div>
                            </section>
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
}
