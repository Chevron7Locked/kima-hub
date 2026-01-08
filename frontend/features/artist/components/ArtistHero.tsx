"use client";

import { Music } from "lucide-react";
import Image from "next/image";
import { Artist, ArtistSource, Album } from "../types";
import { ReactNode, lazy, Suspense } from "react";
import { useArtistDisplayData } from "@/hooks/useMetadataDisplay";

// Lazy load MetadataEditor - modal component opened on user action
const MetadataEditor = lazy(() => import("@/components/MetadataEditor").then(mod => ({ default: mod.MetadataEditor })));

interface ArtistHeroProps {
    artist: Artist;
    source: ArtistSource;
    albums: Album[];
    heroImage: string | null;
    colors: any;
    onReload: () => void;
    children?: ReactNode;
}

export function ArtistHero({
    artist,
    source,
    albums,
    heroImage,
    colors,
    onReload,
    children,
}: ArtistHeroProps) {
    const displayData = useArtistDisplayData(artist);
    const ownedAlbums = albums.filter((a) => a.owned);

    return (
        <div className="relative">
            {/* Background Image with VibrantJS gradient */}
            {heroImage ? (
                <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute inset-0 scale-110 blur-md opacity-50">
                        <Image
                            src={heroImage}
                            alt={displayData.name}
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
                    {/* Artist Image - Circular */}
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded-full shadow-2xl shrink-0 overflow-hidden relative">
                        {heroImage ? (
                            <Image
                                src={heroImage}
                                alt={displayData.name}
                                fill
                                sizes="(max-width: 768px) 140px, 192px"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Music className="w-16 h-16 text-gray-600" />
                            </div>
                        )}
                    </div>

                    {/* Artist Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">
                            Artist
                        </p>
                        <div className="flex items-center gap-3 group mb-2">
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2">
                                {displayData.name}
                            </h1>
                            {displayData.hasUserOverrides && (
                                <span className="px-2 py-0.5 text-xs bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/30 shrink-0">
                                    Edited
                                </span>
                            )}
                            {source === "library" && (
                                <Suspense fallback={null}>
                                    <MetadataEditor
                                        type="artist"
                                        id={artist.id}
                                        currentData={{
                                            name: displayData.name,
                                            bio: displayData.summary,
                                            genres: displayData.genres,
                                            mbid: artist.mbid,
                                            heroUrl: displayData.heroUrl,
                                            // Pass originals for reset comparison
                                            _originalName: artist.name,
                                            _originalBio:
                                                artist.summary ?? artist.bio,
                                            _originalGenres:
                                                artist.genres ?? artist.tags ?? [],
                                            _originalHeroUrl:
                                                artist.heroUrl ?? artist.image,
                                            _hasUserOverrides:
                                                displayData.hasUserOverrides,
                                        }}
                                        onSave={async () => {
                                            await onReload();
                                        }}
                                    />
                                </Suspense>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-sm text-white/70">
                            {artist.listeners && artist.listeners > 0 && (
                                <>
                                    <span>
                                        {artist.listeners.toLocaleString()}{" "}
                                        listeners
                                    </span>
                                    <span className="mx-1">•</span>
                                </>
                            )}
                            {albums.length > 0 && (
                                <>
                                    <span>{albums.length} albums</span>
                                    {ownedAlbums.length > 0 && (
                                        <>
                                            <span className="mx-1">•</span>
                                            <span className="text-[#ecb200]">
                                                {ownedAlbums.length} owned
                                            </span>
                                        </>
                                    )}
                                </>
                            )}
                        </div>
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
