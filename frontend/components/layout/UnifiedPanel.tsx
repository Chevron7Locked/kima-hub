"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { useNotifications, useActiveDownloads } from "@/hooks/useNotifications";
import { ActivityIconBar, type ActivityType } from "@/features/vibe/ActivityIconBar";
import {
    type VibeTab,
    ActivityContent,
    ActivityHeader,
    TabBar,
    TabContent,
} from "@/features/vibe/panel-shared";

interface UnifiedPanelProps {
    isOpen: boolean;
    onToggle: () => void;
}

export function UnifiedPanel({ isOpen, onToggle }: UnifiedPanelProps) {
    const [activeTab, setActiveTab] = useState<VibeTab>("now-playing");
    const [expandedActivity, setExpandedActivity] = useState<ActivityType | null>(null);
    const { unreadCount } = useNotifications();
    const { downloads: activeDownloads } = useActiveDownloads();
    const hasActivity = unreadCount > 0 || activeDownloads.length > 0;

    const handleToggleActivity = (type: ActivityType) => {
        setExpandedActivity((prev) => (prev === type ? null : type));
    };

    return (
        <div
            className="shrink-0 h-full relative z-10"
            style={{ width: isOpen ? 380 : 48 }}
        >
            <div
                className="absolute inset-y-0 right-0 w-[380px] bg-[var(--bg-primary)] flex flex-col overflow-hidden transition-transform duration-200 ease-out rounded-lg"
                style={{
                    transform: isOpen ? "translateX(0)" : "translateX(332px)",
                    willChange: "transform",
                }}
            >
                {/* Collapsed strip */}
                <div
                    onClick={onToggle}
                    className={cn(
                        "absolute left-0 top-0 bottom-0 w-12 flex items-center justify-center cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors z-10",
                        isOpen && "pointer-events-none opacity-0",
                    )}
                    title="Open panel"
                >
                    <ChevronLeft className="w-5 h-5 text-white/40" />
                    {hasActivity && (
                        <span className="absolute top-4 right-3 w-1.5 h-1.5 rounded-full bg-[#22c55e]" />
                    )}
                </div>

                {/* Expanded content */}
                <div
                    className={cn(
                        "flex flex-col h-full transition-opacity duration-150",
                        isOpen ? "opacity-100" : "opacity-0 pointer-events-none",
                    )}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 bg-[#22c55e] rounded-full" />
                            <span className="text-[10px] font-mono font-black text-gray-600 uppercase tracking-wider">
                                Feed
                            </span>
                        </div>
                        <button
                            onClick={onToggle}
                            className="p-1 hover:bg-white/10 transition-colors"
                            title="Collapse panel"
                        >
                            <ChevronRight className="w-4 h-4 text-gray-600" />
                        </button>
                    </div>

                    {/* Activity icon bar */}
                    <ActivityIconBar
                        expandedActivity={expandedActivity}
                        onToggleActivity={handleToggleActivity}
                    />

                    {expandedActivity ? (
                        <>
                            <ActivityHeader
                                type={expandedActivity}
                                onClose={() => setExpandedActivity(null)}
                            />
                            <div className="flex-1 overflow-y-auto">
                                <ActivityContent type={expandedActivity} />
                            </div>
                        </>
                    ) : (
                        <>
                            <TabBar activeTab={activeTab} onTabClick={setActiveTab} />
                            <TabContent activeTab={activeTab} />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
