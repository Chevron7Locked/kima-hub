"use client";

import { Mic2, ArrowLeft } from "lucide-react";
import Image from "next/image";
import { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ColorPalette } from "@/hooks/useImageColor";

interface PodcastHeroProps {
    title: string;
    author: string;
    description?: string;
    genres?: string[];
    heroImage: string | null;
    colors: ColorPalette | null;
    episodeCount: number;
    inProgressCount: number;
    children?: ReactNode;
}

function truncateDescription(description: string, maxLen: number): string {
    const clean = description.replace(/<[^>]*>/g, "").trim();
    if (clean.length <= maxLen) return clean;
    return clean.substring(0, maxLen).trimEnd() + "...";
}

export function PodcastHero({
    title,
    author,
    description,
    genres,
    heroImage,
    colors,
    episodeCount,
    inProgressCount,
    children,
}: PodcastHeroProps) {
    const router = useRouter();

    return (
        <div className="relative">
            {/* Background with VibrantJS gradient */}
            {heroImage ? (
                <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute inset-0 scale-110 blur-md opacity-40">
                        <Image
                            src={heroImage}
                            alt={title}
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
                            : "linear-gradient(to bottom, #0f1a2e 0%, #0a0f1a 50%, #0a0a0a 100%)",
                    }}
                />
            )}

            {/* Hero Content */}
            <div className="relative px-4 md:px-8 pt-8 pb-6">
                <div className="max-w-[1800px] mx-auto">
                    {/* Back navigation */}
                    <button
                        onClick={() => router.push("/podcasts")}
                        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white transition-colors mb-6 uppercase tracking-wider"
                    >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        Podcasts
                    </button>

                    {/* System status */}
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-1.5 h-1.5 bg-[#3b82f6] rounded-full" />
                        <span className="text-xs font-mono text-white/50 uppercase tracking-wider">
                            Podcast
                        </span>
                    </div>

                    <div className="flex items-end gap-6">
                        {/* Cover Art - Square with border treatment */}
                        <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[var(--bg-primary)] rounded-lg shadow-2xl shrink-0 overflow-hidden relative border-2 border-white/10">
                            {heroImage ? (
                                <Image
                                    src={heroImage}
                                    alt={title}
                                    fill
                                    sizes="(max-width: 768px) 140px, 192px"
                                    className="object-cover"
                                    priority
                                    unoptimized
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <Mic2 className="w-16 h-16 text-gray-700" />
                                </div>
                            )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0 pb-1">
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-black text-white leading-tight line-clamp-2 mb-2 tracking-tighter">
                                {title}
                            </h1>

                            {description && (
                                <p className="text-sm text-white/40 line-clamp-2 max-w-3xl mb-3 hidden md:block">
                                    {truncateDescription(description, 200)}
                                </p>
                            )}

                            {/* Metadata row */}
                            <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-white/50 uppercase tracking-wider">
                                <span className="font-black text-white normal-case tracking-tight text-sm">
                                    {author}
                                </span>
                                <span className="text-white/20">|</span>
                                <span>
                                    {episodeCount} {episodeCount === 1 ? "episode" : "episodes"}
                                </span>
                                {inProgressCount > 0 && (
                                    <>
                                        <span className="text-white/20">|</span>
                                        <span className="text-[#3b82f6]">
                                            {inProgressCount} in progress
                                        </span>
                                    </>
                                )}
                            </div>

                            {/* Genre tags */}
                            {genres && genres.length > 0 && (
                                <div className="hidden md:flex flex-wrap gap-1.5 mt-3">
                                    {genres.slice(0, 4).map((genre: string) => (
                                        <span
                                            key={genre}
                                            className="px-2.5 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] font-mono text-white/60 uppercase tracking-wider"
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
