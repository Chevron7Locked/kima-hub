"use client";

import DOMPurify from "dompurify";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useImageColor } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";

import { useAudiobookData } from "@/features/audiobook/hooks/useAudiobookData";
import { useAudiobookActions } from "@/features/audiobook/hooks/useAudiobookActions";

import { AudiobookHero } from "@/features/audiobook/components/AudiobookHero";
import { AudiobookActionBar } from "@/features/audiobook/components/AudiobookActionBar";
import { SectionList } from "@/features/audiobook/components/SectionList";

export default function AudiobookDetailPage() {
    const { audiobookId, audiobook, isLoading, refetch, heroImage, colorExtractionImage, metadata } =
        useAudiobookData();

    const { colors } = useImageColor(colorExtractionImage);

    const {
        isThisBookPlaying,
        isPlaying,
        currentTime,
        handlePlayPause,
        handleMarkAsCompleted,
        handleResetProgress,
        seekToSection,
    } = useAudiobookActions(audiobookId, audiobook, refetch);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!audiobook) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <p className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                    Audiobook not found
                </p>
            </div>
        );
    }

    const showDescription =
        audiobook.description &&
        !audiobook.description.match(/^(Read by|Narrated by):/i) &&
        audiobook.description.replace(/<[^>]*>/g, "").trim().length > 20;

    return (
        <div className="min-h-screen flex flex-col bg-gradient-to-b from-[#0a0a0a] to-black">
            <AudiobookHero
                audiobook={audiobook}
                heroImage={heroImage}
                colors={colors}
                metadata={metadata}
                formatTime={formatTime}
            >
                <AudiobookActionBar
                    audiobook={audiobook}
                    isThisBookPlaying={isThisBookPlaying}
                    isPlaying={isPlaying}
                    currentTime={currentTime}
                    onPlayPause={handlePlayPause}
                    onResetProgress={handleResetProgress}
                    onMarkAsCompleted={handleMarkAsCompleted}
                    formatTime={formatTime}
                />
            </AudiobookHero>

            {/* Main Content */}
            <div className="relative flex-1">
                {/* Color gradient continuation */}
                <div
                    className="absolute inset-x-0 top-0 pointer-events-none"
                    style={{
                        height: "25vh",
                        background: colors
                            ? `linear-gradient(to bottom, ${colors.vibrant}10 0%, ${colors.vibrant}05 40%, transparent 100%)`
                            : "transparent",
                    }}
                />

                <div className="relative max-w-[1800px] mx-auto px-4 md:px-8 py-8 space-y-10">
                    {/* Sections */}
                    {audiobook.sections && audiobook.sections.length > 0 && (
                        <div>
                            <SectionList
                                sections={audiobook.sections}
                                onSeekToSection={seekToSection}
                                formatTime={formatTime}
                            />
                        </div>
                    )}

                    {/* About */}
                    {showDescription && (
                        <div>
                            <section>
                                <div className="flex items-center gap-3 mb-4">
                                    <span className="w-1 h-6 bg-gradient-to-b from-[#f59e0b] to-[#d97706] rounded-full shrink-0" />
                                    <h2 className="text-xl font-bold tracking-tight">About</h2>
                                    <span className="flex-1 border-t border-white/10" />
                                </div>
                                <div className="relative overflow-hidden rounded-lg border border-white/10 bg-[var(--bg-primary)] p-5">
                                    <div
                                        className="prose prose-invert prose-sm max-w-none text-white/50 [&_a]:text-[#f59e0b] [&_a]:no-underline [&_a:hover]:underline text-sm leading-relaxed"
                                        dangerouslySetInnerHTML={{
                                            __html: DOMPurify.sanitize(audiobook.description || ""),
                                        }}
                                    />
                                </div>
                            </section>
                        </div>
                    )}

                    {/* Series info */}
                    {audiobook.series && (
                        <div>
                            <section>
                                <div className="flex items-center gap-3 mb-4">
                                    <span className="w-1 h-6 bg-gradient-to-b from-[#f59e0b] to-[#d97706] rounded-full shrink-0" />
                                    <h2 className="text-xl font-bold tracking-tight">Series</h2>
                                    <span className="flex-1 border-t border-white/10" />
                                </div>
                                <div className="flex items-center gap-3 text-sm">
                                    <span className="text-[#f59e0b] font-bold tracking-tight">
                                        {audiobook.series.name}
                                    </span>
                                    <span className="text-white/20">|</span>
                                    <span className="text-xs font-mono text-white/50 uppercase tracking-wider">
                                        Book {audiobook.series.sequence}
                                    </span>
                                </div>
                            </section>
                        </div>
                    )}

                    {/* Playback hint */}
                    <div>
                        <p className="text-micro font-mono text-white/20 uppercase tracking-wider pt-4">
                            Use the player controls in the bottom bar for playback speed, seeking, and volume.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
