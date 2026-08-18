"use client";

import type { AudiobookSection } from "../types";

interface SectionListProps {
    sections: AudiobookSection[];
    onSeekToSection: (startTime: number) => void;
    formatTime: (seconds: number) => string;
}

export function SectionList({
    sections,
    onSeekToSection,
    formatTime,
}: SectionListProps) {
    if (!sections || sections.length === 0 || sections.length > 50) {
        return null;
    }

    return (
        <section>
            <div className="flex items-center gap-3 mb-6">
                <span className="w-1 h-8 bg-gradient-to-b from-[#f59e0b] to-[#d97706] rounded-full shrink-0" />
                <h2 className="text-2xl font-bold tracking-tight uppercase">Chapters</h2>
                <span className="text-xs font-mono text-[#f59e0b]">
                    {sections.length}
                </span>
                <span className="flex-1 border-t border-white/10" />
            </div>

            <div className="rounded-lg border border-white/10 bg-[var(--bg-primary)] overflow-hidden">
                <div className="divide-y divide-white/5">
                    {sections.map((section, index) => (
                        <button
                            key={section.index}
                            onClick={() => onSeekToSection(section.start)}
                            className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors group flex items-center gap-4"
                        >
                            <span className="text-xs font-mono text-white/30 w-6 text-right shrink-0">
                                {index + 1}
                            </span>
                            <span className="text-sm font-bold text-white group-hover:text-[#f59e0b] transition-colors truncate tracking-tight">
                                {section.title}
                            </span>
                            <span className="ml-auto text-micro font-mono text-white/30 uppercase tracking-wider shrink-0">
                                {formatTime(section.start)}
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </section>
    );
}
