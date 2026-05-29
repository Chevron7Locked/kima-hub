"use client";

import type { AudiobookChapter } from "../types";

interface ChapterListProps {
    chapters: AudiobookChapter[];
    onSeekToChapter: (startTime: number) => void;
    formatTime: (seconds: number) => string;
}

export function ChapterList({
    chapters,
    onSeekToChapter,
    formatTime,
}: ChapterListProps) {
    if (!chapters || chapters.length === 0 || chapters.length > 50) {
        return null;
    }

    return (
        <section>
            <div className="flex items-center gap-3 mb-6">
                <span className="w-1 h-8 bg-gradient-to-b from-[#f59e0b] to-[#d97706] rounded-full shrink-0" />
                <h2 className="text-2xl font-black tracking-tighter uppercase">Chapters</h2>
                <span className="text-xs font-mono text-[#f59e0b]">
                    {chapters.length}
                </span>
                <span className="flex-1 border-t border-white/10" />
            </div>

            <div className="rounded-lg border border-white/10 bg-[var(--bg-primary)] overflow-hidden">
                <div className="divide-y divide-white/5">
                    {chapters.map((chapter, index) => (
                        <button
                            key={chapter.id}
                            onClick={() => onSeekToChapter(chapter.start)}
                            className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors group flex items-center gap-4"
                        >
                            <span className="text-xs font-mono text-white/30 w-6 text-right shrink-0">
                                {index + 1}
                            </span>
                            <span className="text-sm font-black text-white group-hover:text-[#f59e0b] transition-colors truncate tracking-tight">
                                {chapter.title}
                            </span>
                            <span className="ml-auto text-[10px] font-mono text-white/30 uppercase tracking-wider shrink-0">
                                {formatTime(chapter.start)}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </section>
    );
}
