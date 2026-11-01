"use client";

import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { useAudioState } from "@/lib/audio-state-context";
import { QueueTab } from "@/features/vibe/tabs/QueueTab";
import { ArtistAbout, NowPlayingStrip } from "@/features/vibe/tabs/NowPlayingTab";
import { LyricsView } from "@/components/lyrics/LyricsView";
import {
    ActivityOptions,
    ActivityPane,
    isActivityView,
    useActivityCounts,
    type ActivityView,
} from "@/components/activity/ActivityBody";
import { PanelHeading, PanelOptions, panelIconButton, panelTabId } from "./panelChrome";

interface UnifiedPanelProps {
    isOpen: boolean;
    onToggle: () => void;
}

type Listening = "up-next" | "lyrics" | "about";

const OPEN_WIDTH = 380;
const CLOSED_WIDTH = 16;

/**
 * The desktop panel on the right, in two halves with one grammar, the same as the left library panel's: listening
 * above (the playing song, then what is next, its lyrics or its artist) and activity below (everything Kima is doing,
 * or one kind of it). Pages can hand it settings to show instead (Discover's, the lyrics'), which take the panel whole.
 */
export function UnifiedPanel({ isOpen, onToggle }: UnifiedPanelProps) {
    const [listening, setListening] = useState<Listening>("up-next");
    const [activity, setActivity] = useState<ActivityView>("all");
    // A page's settings (Discover's, the lyrics'), put in the panel through useActivityPanelSettings and opened on
    // the "settings" tab.
    const [showSettings, setShowSettings] = useState(false);
    const { settingsContent } = useActivityPanelSettings();
    const { any: hasActivity } = useActivityCounts();
    const { queue, currentIndex } = useAudioState();
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
        // Without preventScroll the browser scrolls the clipped page row sideways to reveal the button, which throws the
        // whole page left for a frame as the panel opens.
        (isOpen ? hideRef : handleRef).current?.focus({ preventScroll: true });
    }, [isOpen]);
    // Closing leaves a page's settings, so reopening shows the halves.
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
            if (isActivityView(tab)) setActivity(tab);
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

    // A page that unmounts takes its settings with it, and the halves show again.
    const settingsActive = showSettings && !!settingsContent;

    return (
        // Only the panel slides. The frame's width (and so the page beside it) changes once, at the start of opening and
        // after closing, because a width that moved with the slide would re-lay-out the page every frame. The frame also
        // clips the panel, so a closed panel cannot hang past the screen edge as scrollable overflow.
        <div
            className={cn(
                "shrink-0 h-full relative overflow-hidden z-(--z-raised)",
                isOpen ? "[transition:width_0s]" : "[transition:width_0s_300ms]",
            )}
            style={{ width: isOpen ? OPEN_WIDTH : CLOSED_WIDTH }}
        >
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
                        // The settings bring their own heading and a back button (leaveActivityPanelSettings).
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
                                <ActivityOptions controls="panel-activity" value={activity} onChange={setActivity} />
                                <div
                                    id="panel-activity"
                                    role="tabpanel"
                                    aria-labelledby={panelTabId("panel-activity", activity)}
                                    className="min-h-0 flex-1 overflow-y-auto">
                                    <ActivityPane view={activity} onOpen={setActivity} />
                                </div>
                            </section>
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
}
