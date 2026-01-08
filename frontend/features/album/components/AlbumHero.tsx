"use client";

import { Disc3 } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { Album, AlbumSource } from "../types";
import { ReactNode, lazy, Suspense } from "react";
import { useAlbumDisplayData } from "@/hooks/useMetadataDisplay";

// Lazy load MetadataEditor - modal component opened on user action
const MetadataEditor = lazy(() => import("@/components/MetadataEditor").then(mod => ({ default: mod.MetadataEditor })));

interface AlbumHeroProps {
    album: Album;
    source: AlbumSource;
    coverUrl: string | null;
    colors: any;
    onReload: () => void;
    children?: ReactNode;
}

export function AlbumHero({
    album,
    source,
    coverUrl,
    colors,
    onReload,
    children,
}: AlbumHeroProps) {
    const displayData = useAlbumDisplayData(album);
    const formatDuration = (seconds?: number) => {
        if (!seconds) return "";
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    const totalDuration = formatDuration(album.duration);

    return (
        <div className="relative">
            {/* Background Image with VibrantJS gradient */}
            {coverUrl ? (
                <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute inset-0 scale-110 blur-md opacity-50">
                        <Image
                            src={coverUrl}
                            alt={album.title}
                            fill
                            sizes="100vw"
                            className="object-cover"
                            priority
                            unoptimized
                        />
                    </div>
                    {/* Dynamic VibrantJS gradient overlays */}
                    <div
                        className="absolute inset-0"
                        style={{
                            background: colors
                                ? `linear-gradient(to bottom, ${colors.vibrant}30 0%, ${colors.darkVibrant}60 40%, ${colors.darkMuted}90 70%, #0a0a0a 100%)`
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
                            ? `linear-gradient(to bottom, ${colors.vibrant}40 0%, ${colors.darkVibrant}80 50%, #0a0a0a 100%)`
                            : "linear-gradient(to bottom, #3d2a1e 0%, #1a1a1a 50%, #0a0a0a 100%)",
                    }}
                />
            )}

            {/* Compact Hero Content - Full Width */}
            <div className="relative px-4 md:px-8 pt-16 pb-6">
                <div className="flex items-end gap-6">
                    {/* Album Cover - Square */}
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden relative">
                        {coverUrl ? (
                            <Image
                                src={coverUrl}
                                alt={album.title}
                                fill
                                sizes="(max-width: 768px) 140px, 192px"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Disc3 className="w-16 h-16 text-gray-600" />
                            </div>
                        )}
                    </div>

                    {/* Album Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">
                            Album
                        </p>
                        <div className="flex items-center gap-2 group mb-2">
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2">
                                {displayData.title}
                            </h1>
                            {displayData.hasUserOverrides && (
                                <span className="px-2 py-0.5 text-xs bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/30 shrink-0">
                                    Edited
                                </span>
                            )}
                            {source === "library" && (
                                <Suspense fallback={null}>
                                    <MetadataEditor
                                        type="album"
                                        id={album.id}
                                        currentData={{
                                            title: displayData.title,
                                            year: displayData.year,
                                            genres: displayData.genres,
                                            mbid: album.mbid,
                                            coverUrl: displayData.coverUrl,
                                            // Pass originals for reset comparison
                                            _originalTitle: album.title,
                                            _originalYear: album.year,
                                            _originalGenres: album.genre ? [album.genre] : [],
                                            _originalCoverUrl: album.coverUrl,
                                            _hasUserOverrides: displayData.hasUserOverrides,
                                        }}
                                        onSave={async () => {
                                            await onReload();
                                        }}
                                    />
                                </Suspense>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-sm text-white/70 mb-1">
                            {album.artist && (
                                <Link
                                    href={`/artist/${
                                        album.artist.mbid || album.artist.id
                                    }`}
                                    className="font-medium text-white hover:underline"
                                >
                                    {album.artist.name}
                                </Link>
                            )}
                            {displayData.year && (
                                <>
                                    <span className="mx-1">•</span>
                                    <span>{displayData.year}</span>
                                </>
                            )}
                            {album.trackCount && album.trackCount > 0 && (
                                <>
                                    <span className="mx-1">•</span>
                                    <span>{album.trackCount} songs</span>
                                </>
                            )}
                            {totalDuration && <span>, {totalDuration}</span>}
                        </div>
                        {album.genre && (
                            <span className="inline-block px-2 py-0.5 bg-white/10 rounded-full text-xs text-white/70">
                                {album.genre}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Action Bar - Full Width */}
            {children && (
                <div className="relative px-4 md:px-8 pb-4">{children}</div>
            )}
        </div>
    );
}
