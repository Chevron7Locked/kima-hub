import React, { memo, useCallback, useMemo, type CSSProperties } from "react";
import Link from "next/link";
import { Album } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { Disc3, Play, Trash2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";

interface AlbumsGridProps {
    albums: Album[];
    onPlay: (albumId: string) => Promise<void>;
    onDelete: (albumId: string, albumTitle: string) => void;
    isLoading?: boolean;
    gridKey?: number;
}

interface AlbumCardItemProps {
    album: Album;
    index: number;
    onPlay: (albumId: string) => Promise<void>;
    onDelete: (albumId: string, albumTitle: string) => void;
}

const AlbumCardItem = memo(
    function AlbumCardItem({
        album,
        index,
        onPlay,
        onDelete,
    }: AlbumCardItemProps) {
        const handlePlay = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onPlay(album.id);
            },
            [album.id, onPlay],
        );
        const handleDelete = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(album.id, album.title);
            },
            [album.id, album.title, onDelete],
        );

        const coverArtUrl = useMemo(
            () => (album.coverArt ? api.getCoverArtUrl(album.coverArt, 200) : null),
            [album.coverArt],
        );

        return (
            <Link
                href={`/album/${album.id}`}
                prefetch={true}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                style={{ "--i": index } as CSSProperties}
                className={cn(
                    "group block",
                    index < 8 ? "animate-rise [animation-delay:calc(var(--i)*45ms)]" : "",
                )}
            >
                <div className="relative bg-[var(--bg-primary)] border-2 border-white/10 rounded-lg overflow-hidden hover:border-[#22c55e]/50 transition-all duration-200 hover:shadow-lg hover:shadow-[#22c55e]/10" style={{ transform: "translateZ(0)" }}>
                    <div className="relative aspect-square">
                        <div className="w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden" style={{ contain: "content" }}>
                            {coverArtUrl ? (
                                <CachedImage
                                    src={coverArtUrl}
                                    alt={album.title}
                                    fill
                                    className="object-cover group-hover:scale-110 transition-transform duration-150"
                                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
                                />
                            ) : (
                                <Disc3 className="w-12 h-12 text-[var(--text-muted)]" />
                            )}
                        </div>

                        {/* Gradient overlay on hover */}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />

                        {/* Play button */}
                        <button
                            onClick={handlePlay}
                            className="touch-reveal absolute bottom-3 right-3 w-11 h-11 rounded-lg bg-[#22c55e] flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 transition-all duration-150 hover:scale-110 hover:bg-[#16a34a]"
                        >
                            <Play className="w-5 h-5 fill-current ml-0.5 text-black" />
                        </button>

                        {/* Delete button */}
                        <button
                            onClick={handleDelete}
                            className="absolute top-2 right-2 w-8 h-8 rounded-lg bg-black/80 hidden md:flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all duration-150 border border-white/20"
                            title="Delete album"
                        >
                            <Trash2 className="w-4 h-4 text-white" />
                        </button>

                        {/* Color accent bar */}
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#22c55e] to-[#16a34a] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150" />
                    </div>

                    {/* Info section with monospace data */}
                    <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                        <h3 className="text-sm font-bold text-white truncate mb-1 tracking-tight">
                            {album.title}
                        </h3>
                        <p className="text-xs tabular-nums text-[var(--text-muted)] truncate">
                            {album.artist?.name}
                        </p>
                    </div>
                </div>
            </Link>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.album.id === nextProps.album.id;
    },
);

const AlbumsGrid = memo(function AlbumsGrid({
    albums,
    onPlay,
    onDelete,
    isLoading = false,
    gridKey,
}: AlbumsGridProps) {
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (albums.length === 0) {
        return (
            <EmptyState
                icon={<Disc3 className="w-12 h-12" />}
                title="No albums yet"
                description="Your library is empty. Sync your music to get started."
            />
        );
    }

    return (
        <div
            key={gridKey}
            data-tv-section="library-albums"
            className="grid-media"
        >
            {albums.map((album, index) => (
                <AlbumCardItem
                    key={album.id}
                    album={album}
                    index={index}
                    onPlay={onPlay}
                    onDelete={onDelete}
                />
            ))}
        </div>
    );
});

export { AlbumsGrid };
