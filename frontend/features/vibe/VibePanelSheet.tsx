"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { motion, useDragControls, type PanInfo } from "framer-motion";
import { ActivityIconBar, type ActivityType } from "./ActivityIconBar";
import {
    type VibeTab,
    ActivityContent,
    ActivityHeader,
    TabBar,
    TabContent,
} from "./panel-shared";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { Waypoints, Sparkles, AudioWaveform } from "lucide-react";

type SnapPoint = "peek" | "half" | "full";

const PEEK_HEIGHT = 80;

export interface VibePanelSheetProps {
    selectedTrackId?: string | null;
    selectedTrackTitle?: string | null;
    selectedTrackArtist?: string | null;
    onTrackOperation?: (op: "vibe" | "similar") => void;
    onStartSongPath?: () => void;
    songPathActive?: boolean;
}

export function VibePanelSheet({
    selectedTrackId,
    selectedTrackTitle,
    selectedTrackArtist,
    onTrackOperation,
    onStartSongPath,
    songPathActive = false,
}: VibePanelSheetProps) {
    const [snap, setSnap] = useState<SnapPoint>("peek");
    const [activeTab, setActiveTab] = useState<VibeTab>("now-playing");
    const [expandedActivity, setExpandedActivity] = useState<ActivityType | null>(null);
    const [sheetHeight, setSheetHeight] = useState(600);
    const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
    const dragControls = useDragControls();

    useEffect(() => {
        const update = () => setSheetHeight(window.innerHeight * 0.9);
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, []);

    const snapY = useMemo(() => ({
        peek: sheetHeight - PEEK_HEIGHT,
        half: sheetHeight * 0.5,
        full: 0,
    }), [sheetHeight]);

    const handleDragEnd = useCallback((_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
        const currentY = snapY[snap] + info.offset.y;
        const vy = info.velocity.y;

        if (vy > 500) {
            setSnap(snap === "full" ? "half" : "peek");
        } else if (vy < -500) {
            setSnap(snap === "peek" ? "half" : "full");
        } else {
            const entries = Object.entries(snapY) as [SnapPoint, number][];
            entries.sort((a, b) => Math.abs(a[1] - currentY) - Math.abs(b[1] - currentY));
            setSnap(entries[0][0]);
        }
    }, [snap, snapY]);

    const handleToggleActivity = (type: ActivityType) => {
        setExpandedActivity((prev) => (prev === type ? null : type));
        if (snap === "peek") setSnap("half");
    };

    const handleTabClick = (tab: VibeTab) => {
        setActiveTab(tab);
        setExpandedActivity(null);
        if (snap === "peek") setSnap("half");
    };

    return (
        <motion.div
            className="fixed bottom-0 left-0 right-0 z-(--z-scene-panel) bg-[var(--bg-primary)] rounded-t-2xl border-t border-white/10 flex flex-col"
            style={{ height: sheetHeight }}
            animate={{ y: snapY[snap] }}
            transition={prefersReducedMotion
                ? { duration: 0 }
                : { type: "spring", damping: 30, stiffness: 300 }
            }
            drag="y"
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: snapY.peek }}
            dragElastic={0.2}
            onDragEnd={handleDragEnd}
        >
            {/* Drag handle */}
            <div
                className="flex justify-center py-3 cursor-grab active:cursor-grabbing touch-none shrink-0"
                onPointerDown={(e) => dragControls.start(e)}
            >
                <div className="w-10 h-1 bg-white/20 rounded-full" />
            </div>

            {/* Vibe track actions -- shown when a map dot is selected */}
            {selectedTrackId && onTrackOperation && onStartSongPath && (
                <div className="shrink-0 px-3 pb-2 border-b border-white/5">
                    {(selectedTrackTitle || selectedTrackArtist) && (
                        <p className="text-xs text-[var(--text-muted)] truncate mb-2 mt-0.5">
                            <span className="text-[var(--text-secondary)]">{selectedTrackTitle}</span>
                            {selectedTrackArtist && (
                                <> &middot; {selectedTrackArtist}</>
                            )}
                        </p>
                    )}
                    <div className="flex gap-2">
                        <button
                            onClick={() => onTrackOperation("vibe")}
                            aria-label="Match Vibe -- build a queue of similar-sounding tracks"
                            className="flex-1 flex flex-col items-center gap-1 min-h-[52px] py-2 px-1 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 hover:border-purple-500/40 text-purple-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/60"
                        >
                            <Sparkles className="w-4 h-4 shrink-0" />
                            <span className="text-micro font-medium leading-tight text-center">Match Vibe</span>
                        </button>
                        <button
                            onClick={() => onTrackOperation("similar")}
                            aria-label="Similar -- highlight similar tracks on the map"
                            className="flex-1 flex flex-col items-center gap-1 min-h-[52px] py-2 px-1 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 hover:border-purple-500/40 text-purple-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/60"
                        >
                            <AudioWaveform className="w-4 h-4 shrink-0" />
                            <span className="text-micro font-medium leading-tight text-center">Similar</span>
                        </button>
                        <button
                            onClick={onStartSongPath}
                            aria-label="Song Path -- set this track as the start of a song path, then tap the destination"
                            className="flex-1 flex flex-col items-center gap-1 min-h-[52px] py-2 px-1 rounded-lg bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 hover:border-purple-500/40 text-purple-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/60"
                        >
                            <Waypoints className="w-4 h-4 shrink-0" />
                            <span className="text-micro font-medium leading-tight text-center">Song Path</span>
                        </button>
                    </div>
                    {songPathActive && (
                        <p className="text-micro text-purple-500/70 text-center mt-2 animate-pulse">
                            Tap another track to complete the song path
                        </p>
                    )}
                </div>
            )}

            {/* Activity icon bar */}
            <div className="shrink-0">
                <ActivityIconBar
                    expandedActivity={expandedActivity}
                    onToggleActivity={handleToggleActivity}
                />
            </div>

            {expandedActivity ? (
                <>
                    <ActivityHeader
                        type={expandedActivity}
                        onClose={() => setExpandedActivity(null)}
                    />
                    <div className="flex-1 overflow-y-auto overscroll-contain">
                        <ActivityContent type={expandedActivity} />
                    </div>
                </>
            ) : (
                <>
                    <TabBar activeTab={activeTab} onTabClick={handleTabClick} />
                    <TabContent activeTab={activeTab} />
                </>
            )}
        </motion.div>
    );
}
