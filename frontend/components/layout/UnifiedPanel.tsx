"use client";

import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { useAudioState } from "@/lib/audio-state-context";
import { QueueTab } from "@/features/vibe/tabs/QueueTab";
import { ArtistAbout, NowPlayingHero } from "@/features/vibe/tabs/NowPlayingTab";
import { LyricsView } from "@/components/lyrics/LyricsView";
import {
    ActivityOptions,
    ActivityPane,
    isActivityView,
    useActivityCounts,
    type ActivityView,
} from "@/components/activity/ActivityBody";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PanelOptions, panelTabId } from "./panelChrome";

interface UnifiedPanelProps {
    isOpen: boolean;
    onToggle: () => void;
}

type Listening = "up-next" | "lyrics" | "about";
type Main = "listening" | "activity";

const OPEN_WIDTH = 380;
const CLOSED_WIDTH = 24;
// The tab not showing stays laid out under the other, so its scroll position and row sizes survive; inert and
// invisible keep it out of the tab order and the accessibility tree.
const pane = "flex min-h-0 flex-1 flex-col";
const paneAway = "invisible pointer-events-none absolute inset-0";

/**
 * The desktop panel on the right. Listening leads with what is playing, then what is next, its lyrics or its artist;
 * activity is everything Kima is doing. The foot switches them, and the other stays mounted out of sight. Each opening
 * starts on listening, or on activity when asked for or when nothing is playing. Pages can put their settings here.
 */
export function UnifiedPanel({ isOpen, onToggle }: UnifiedPanelProps) {
    const [listening, setListening] = useState<Listening>("up-next");
    // Null until someone chooses: the panel then follows whether anything is playing, and audio state that arrives
    // after the first render never flips a choice.
    const [chosen, setChosen] = useState<Main | null>(null);
    // Each opening decides its tab: activity when a request for it came in since the last opening, else listening.
    // Deciding at the opening, not the closing, keeps the fade-out from flashing and a request made while closed.
    const [asked, setAsked] = useState(false);
    const [wasOpen, setWasOpen] = useState(isOpen);
    if (wasOpen !== isOpen) {
        setWasOpen(isOpen);
        if (isOpen) setChosen(asked ? "activity" : null);
        setAsked(false);
    }
    const [activity, setActivity] = useState<ActivityView>("all");
    // A page's settings (Discover's, the lyrics'), put in the panel through useActivityPanelSettings and opened on
    // the "settings" tab.
    const [showSettings, setShowSettings] = useState(false);
    const { settingsContent } = useActivityPanelSettings();
    const { any: hasActivity, unread, downloads } = useActivityCounts();
    const { queue, currentIndex, currentTrack, currentAudiobook, currentPodcast } = useAudioState();
    const playing = !!(currentTrack || currentAudiobook || currentPodcast);
    // Something starting settles this opening on listening, so clearing the queue leaves the panel where it is.
    if (chosen === null && playing) setChosen("listening");
    const main: Main = chosen ?? (playing ? "listening" : "activity");
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
    // Closing leaves a page's settings, so reopening shows the panel's own content.
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
            if (isActivityView(tab)) {
                setActivity(tab);
                setChosen("activity");
                setAsked(true);
            }
        };
        // Leaving a page's settings returns to the panel as it was.
        const handleLeave = () => setShowSettings(false);
        window.addEventListener("set-activity-panel-tab", handleSetTab);
        window.addEventListener("leave-activity-panel-settings", handleLeave);
        return () => {
            window.removeEventListener("set-activity-panel-tab", handleSetTab);
            window.removeEventListener("leave-activity-panel-settings", handleLeave);
        };
    }, []);

    // A page that unmounts takes its settings with it, and the panel's own content shows again.
    const settingsActive = showSettings && !!settingsContent;

    return (
        // The frame's width pushes and pulls the page beside it, on the same curve and timing as the box, so the page
        // follows the slide. The box grows from the frame's right edge, as the left library's does, so it never hangs
        // past the screen as scrollable overflow.
        <div
            className="shrink-0 h-full relative z-(--z-scene-panel) transition-[width] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none"
            style={{ width: isOpen ? OPEN_WIDTH : CLOSED_WIDTH }}
        >
            <aside
                id="activity-panel"
                aria-label="listening and activity"
                className="absolute inset-y-0 right-0 overflow-hidden bg-[var(--bg-chrome)] transition-[width] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none"
                style={{ width: isOpen ? OPEN_WIDTH : CLOSED_WIDTH }}
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
                        "group absolute inset-y-0 left-0 z-(--z-raised) flex w-6 flex-col items-center pt-3 outline-none transition-colors duration-150 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60",
                        isOpen && "pointer-events-none opacity-0",
                    )}
                >
                    <ChevronLeft
                        aria-hidden="true"
                        className="h-3.5 w-3.5 text-[var(--text-secondary)] transition-colors duration-150 group-hover:text-white"
                    />
                    {hasActivity && <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 rounded-full bg-brand" />}
                </button>

                {/* Expanded content, at its full width from the box's left edge so it travels with it; inert while collapsed. */}
                <div
                    inert={!isOpen}
                    style={{ width: OPEN_WIDTH }}
                    className={cn(
                        "absolute inset-y-0 left-0 flex min-h-0 flex-col transition-opacity duration-300",
                        isOpen ? "opacity-100" : "pointer-events-none opacity-0",
                    )}
                >
                    {settingsActive ? (
                        // The settings bring their own heading and a back button (leaveActivityPanelSettings).
                        <div className="flex-1 min-h-0 overflow-hidden">{settingsContent}</div>
                    ) : (
                        <>
                            {/* Over the artwork or the activity heading, so it stays in one place. */}
                            <button
                                ref={hideRef}
                                type="button"
                                onClick={handleCollapse}
                                aria-label="hide panel"
                                title="hide panel"
                                className="absolute right-2 top-2 z-(--z-raised) flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white/85 outline-none transition-colors duration-150 hover:text-white focus-visible:ring-2 focus-visible:ring-brand/60"
                            >
                                <ChevronRight aria-hidden="true" className="h-4 w-4" />
                            </button>

                            <div
                                id="panel-main"
                                role="tabpanel"
                                aria-labelledby={panelTabId("panel-main", main)}
                                className="relative flex min-h-0 flex-1 flex-col"
                            >
                                <div inert={main !== "listening"} className={cn(pane, main !== "listening" && paneAway)}>
                                    <NowPlayingHero compact={listening !== "up-next"} />
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
                                </div>
                                <div inert={main !== "activity"} className={cn(pane, main !== "activity" && paneAway)}>
                                    <SectionHeader size="xs" title="activity" className="mb-0 h-11 pl-3 pr-10" />
                                    <ActivityOptions controls="panel-activity" value={activity} onChange={setActivity} />
                                    <div
                                        id="panel-activity"
                                        role="tabpanel"
                                        aria-labelledby={panelTabId("panel-activity", activity)}
                                        className="min-h-0 flex-1 overflow-y-auto">
                                        <ActivityPane view={activity} onOpen={setActivity} />
                                    </div>
                                </div>
                            </div>

                            <PanelOptions<Main>
                                label="panel"
                                controls="panel-main"
                                value={main}
                                onChange={setChosen}
                                quiet
                                options={[
                                    { key: "listening", label: "listening" },
                                    { key: "activity", label: "activity", count: unread + downloads, urgent: true },
                                ]}
                            />
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
}
