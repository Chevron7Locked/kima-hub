import React, { memo, useCallback, useMemo } from "react";
import Link from "next/link";
import { Music, Play, Trash2 } from "lucide-react";
import { Artist } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { cn } from "@/utils/cn";

interface ArtistsGridProps {
    artists: Artist[];
    onPlay: (artistId: string) => Promise<void>;
    onDelete: (artistId: string, artistName: string) => void;
    isLoading?: boolean;
    gridKey?: number;
}

const getArtistImageSrc = (coverArt?: string): string | null => {
    if (!coverArt) return null;
    return api.getCoverArtUrl(coverArt, 200);
};

interface ArtistCardItemProps {
    artist: Artist;
    index: number;
    onPlay: (artistId: string) => Promise<void>;
    onDelete: (artistId: string, artistName: string) => void;
}

const ArtistCardItem = memo(
    function ArtistCardItem({
        artist,
        index,
        onPlay,
        onDelete,
    }: ArtistCardItemProps) {
        const handlePlay = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onPlay(artist.id);
            },
            [artist.id, onPlay],
        );
        const handleDelete = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(artist.id, artist.name);
            },
            [artist.id, artist.name, onDelete],
        );

        const coverArtUrl = useMemo(
            () => getArtistImageSrc(artist.coverArt),
            [artist.coverArt],
        );

        return (
            <Link
                href={`/artist/${artist.id}`}
                prefetch={true}
                data-tv-card
                data-tv-card-index={index}
                style={{ "--i": index } as React.CSSProperties}
                className={cn(
                    "group block",
                    index < 8 ? "animate-rise [animation-delay:calc(var(--i)*45ms)]" : "",
                )}
            >
                <div className="relative bg-[var(--bg-primary)] border-2 border-white/10 rounded-lg overflow-hidden hover:border-[#fca200]/50 transition-all duration-200 hover:shadow-lg hover:shadow-[#fca200]/10" style={{ transform: "translateZ(0)" }}>
                    <div className="relative aspect-square">
                        <div className="w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden" style={{ contain: "content" }}>
                            {coverArtUrl ? (
                                <CachedImage
                                    src={coverArtUrl}
                                    alt={artist.name}
                                    fill
                                    className="object-cover group-hover:scale-110 transition-transform duration-150"
                                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
                                />
                            ) : (
                                <Music className="w-12 h-12 text-[var(--text-muted)]" />
                            )}
                        </div>

                        {/* Gradient overlay on hover */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />

                        {/* Play button */}
                        <button
                            onClick={handlePlay}
                            className="touch-reveal absolute bottom-3 right-3 w-11 h-11 rounded-lg bg-[#fca200] flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 transition-all duration-150 hover:scale-110 hover:bg-[#d48c00]"
                        >
                            <Play className="w-5 h-5 fill-current ml-0.5 text-white" />
                        </button>

                        {/* Delete button */}
                        <button
                            onClick={handleDelete}
                            className="absolute top-2 right-2 w-8 h-8 rounded-lg bg-black/80 hidden md:flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all duration-150 border border-white/20"
                            title="Delete artist"
                        >
                            <Trash2 className="w-4 h-4 text-white" />
                        </button>

                        {/* Color accent bar */}
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#fca200] to-[#d48c00] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150" />
                    </div>

                    {/* Info section with monospace data */}
                    <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                        <h3 className="text-sm font-bold text-white truncate mb-1 tracking-tight">
                            {artist.name}
                        </h3>
                        <p className="text-xs tabular-nums text-[var(--text-muted)]">
                            {artist.albumCount || 0} albums
                        </p>
                    </div>
                </div>
            </Link>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.artist.id === nextProps.artist.id;
    },
);

const ArtistsGrid = memo(function ArtistsGrid({
    artists,
    onPlay,
    onDelete,
    isLoading = false,
    gridKey,
}: ArtistsGridProps) {
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (artists.length === 0) {
        return (
            <EmptyState
                icon={<Music className="w-12 h-12" />}
                title="No artists yet"
                description="Your library is empty. Sync your music to get started."
            />
        );
    }

    return (
        <div
            key={gridKey}
            data-tv-section="library-artists"
            className="grid-media"
        >
            {artists.map((artist, index) => (
                <ArtistCardItem
                    key={artist.id}
                    artist={artist}
                    index={index}
                    onPlay={onPlay}
                    onDelete={onDelete}
                />
            ))}
        </div>
    );
});

export { ArtistsGrid };
