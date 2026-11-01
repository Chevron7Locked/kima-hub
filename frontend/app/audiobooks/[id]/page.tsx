"use client";

import DOMPurify from "dompurify";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useImageColor } from "@/hooks/useImageColor";
import { formatTime } from "@/lib/format";

import { useAudiobookData } from "@/features/audiobook/hooks/useAudiobookData";
import { useAudiobookActions } from "@/features/audiobook/hooks/useAudiobookActions";

import { AudiobookHero } from "@/features/audiobook/components/AudiobookHero";
import { ColorWash } from "@/features/spoken/ColorWash";
import { AudiobookActionBar } from "@/features/audiobook/components/AudiobookActionBar";
import { SectionList } from "@/features/audiobook/components/SectionList";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageMessage } from "@/components/ui/PageMessage";

export default function AudiobookDetailPage() {
    const { audiobookId, audiobook, isLoading, refetch, heroImage, colorExtractionImage } =
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
        return <LoadingScreen />;
    }

    if (!audiobook) {
        return (
            <PageMessage
                title="Audiobook not found"
                description="It may have been removed from Audiobookshelf."
                action={{ label: "Audiobooks", href: "/audiobooks" }}
            />
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

            <div className="relative flex-1">
                <ColorWash colors={colors} />

                <div className="relative page-shell pt-8 page-end section-stack">
                    {audiobook.sections && audiobook.sections.length > 0 && (
                        <div>
                            <SectionList
                                sections={audiobook.sections}
                                onSeekToSection={seekToSection}
                                formatTime={formatTime}
                            />
                        </div>
                    )}

                    {showDescription && (
                        <div>
                            <section>
                                <SectionHeader type="audiobook" title="About" size="sm" />
                                <div className="relative overflow-hidden rounded-lg border border-white/10 bg-[var(--bg-primary)] p-5">
                                    <div
                                        className="prose prose-invert prose-sm max-w-none text-[var(--text-secondary)] [&_a]:text-brand [&_a]:no-underline [&_a:hover]:underline text-sm leading-relaxed"
                                        dangerouslySetInnerHTML={{
                                            __html: DOMPurify.sanitize(audiobook.description || ""),
                                        }}
                                    />
                                </div>
                            </section>
                        </div>
                    )}

                    {audiobook.series && (
                        <div>
                            <section>
                                <SectionHeader type="audiobook" title="Series" size="sm" />
                                <div className="flex items-center gap-3 text-sm">
                                    <span className="text-brand font-bold tracking-tight">
                                        {audiobook.series.name}
                                    </span>
                                    <span className="text-[var(--text-muted)]">|</span>
                                    <span className="text-xs tabular-nums text-[var(--text-secondary)]">
                                        Book {audiobook.series.sequence}
                                    </span>
                                </div>
                            </section>
                        </div>
                    )}

                    <div>
                        <p className="text-xs text-[var(--text-muted)] pt-4">
                            Use the player controls in the bottom bar for playback speed, seeking, and volume.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
