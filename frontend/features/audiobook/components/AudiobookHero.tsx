"use client";

import { Book, ArrowLeft } from "lucide-react";
import Image from "next/image";
import { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Audiobook } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";

interface AudiobookHeroProps {
    audiobook: Audiobook;
    heroImage: string | null;
    colors: ColorPalette | null;
    metadata: {
        narrator: string | null;
        genre: string | null;
        publishedYear: string | null;
        description: string | null;
    } | null;
    formatTime: (seconds: number) => string;
    children?: ReactNode;
}

function truncateDescription(description: string, maxLen: number): string {
    const clean = description.replace(/<[^>]*>/g, "").trim();
    if (clean.length <= maxLen) return clean;
    return clean.substring(0, maxLen).trimEnd() + "...";
}

export function AudiobookHero({
    audiobook,
    heroImage,
    colors,
    metadata,
    formatTime,
    children,
}: AudiobookHeroProps) {
    const router = useRouter();
    const progressPercent = audiobook.progress?.progress || 0;
    const isFinished = audiobook.progress?.isFinished;

    return (
        <div className="relative">
            {/* Background with VibrantJS gradient */}
            {heroImage ? (
                <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute inset-0 scale-110 blur-md opacity-40">
                        <Image
                            src={heroImage}
                            alt={audiobook.title}
                            fill
                            sizes="100vw"
                            className="object-cover"
                            priority
                            unoptimized
                        />
                    </div>
                    <div
                        className="absolute inset-0"
                        style={{
                            background: colors
                                ? `linear-gradient(to bottom, ${colors.vibrant}20 0%, ${colors.darkVibrant}50 40%, #0a0a0a 100%)`
                                : "linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.7) 40%, #0a0a0a 100%)",
                        }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-transparent to-transparent" />
                </div>
            ) : (
                <div
                    className="absolute inset-0"
                    style={{
                        background: colors
                            ? `linear-gradient(to bottom, ${colors.vibrant}30 0%, ${colors.darkVibrant}60 50%, #0a0a0a 100%)`
                            : "linear-gradient(to bottom, #2a1e0a 0%, #1a140a 50%, #0a0a0a 100%)",
                    }}
                />
            )}

            {/* Hero Content */}
            <div className="relative px-4 md:px-8 pt-8 pb-6">
                <div className="max-w-[1800px] mx-auto">
                    {/* Back navigation */}
                    <button
                        onClick={() => router.push("/audiobooks")}
                        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white transition-colors mb-6 uppercase tracking-wider"
                    >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        Audiobooks
                    </button>

                    {/* System status */}
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-1.5 h-1.5 bg-[#f59e0b] rounded-full" />
                        <span className="text-xs font-mono text-white/50 uppercase tracking-wider">
                            Audiobook
                        </span>
                    </div>

                    <div className="flex items-end gap-6">
                        {/* Cover Art - Square for audiobooks */}
                        <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[var(--bg-primary)] rounded-lg shadow-2xl shrink-0 overflow-hidden relative border-2 border-white/10">
                            {heroImage ? (
                                <Image
                                    src={heroImage}
                                    alt={audiobook.title}
                                    fill
                                    sizes="(max-width: 768px) 140px, 192px"
                                    className="object-cover"
                                    priority
                                    unoptimized
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <Book className="w-16 h-16 text-white/10" />
                                </div>
                            )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0 pb-1">
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2 tracking-tight">
                                {audiobook.title}
                            </h1>

                            {metadata?.description && (
                                <p className="text-sm text-white/40 line-clamp-2 max-w-3xl mb-3 hidden md:block">
                                    {truncateDescription(metadata.description, 200)}
                                </p>
                            )}

                            {/* Metadata row */}
                            <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-white/50 uppercase tracking-wider">
                                <span className="font-bold text-white normal-case tracking-tight text-sm">
                                    {audiobook.author}
                                </span>
                                {metadata?.narrator && (
                                    <>
                                        <span className="text-white/20">|</span>
                                        <span>{metadata.narrator}</span>
                                    </>
                                )}
                                <span className="text-white/20">|</span>
                                <span>{formatTime(audiobook.duration)}</span>
                                <span className="text-white/20">|</span>
                                <span className={isFinished ? "text-green-400" : "text-[#f59e0b]"}>
                                    {isFinished ? "Finished" : `${Math.round(progressPercent)}% complete`}
                                </span>
                            </div>

                            {/* Series & Genre tags */}
                            {(audiobook.series || (audiobook.genres && audiobook.genres.length > 0)) && (
                                <div className="hidden md:flex flex-wrap gap-1.5 mt-3">
                                    {audiobook.series && (
                                        <span className="px-2.5 py-0.5 bg-white/5 border border-white/10 rounded text-micro font-mono text-[#f59e0b] uppercase tracking-wider">
                                            {audiobook.series.name} #{audiobook.series.sequence}
                                        </span>
                                    )}
                                    {audiobook.genres?.slice(0, 3).map((genre: string) => (
                                        <span
                                            key={genre}
                                            className="px-2.5 py-0.5 bg-white/5 border border-white/10 rounded text-micro font-mono text-white/60 uppercase tracking-wider"
                                        >
                                            {genre}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            {children && (
                <div className="relative px-4 md:px-8 pb-4">
                    <div className="max-w-[1800px] mx-auto">
                        {children}
                    </div>
                </div>
            )}
        </div>
    );
}
