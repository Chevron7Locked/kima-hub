import React, { memo, useCallback } from "react";
import { Album } from "../types";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { Disc3, Trash2 } from "lucide-react";
import { api } from "@/lib/api";

interface AlbumsGridProps {
    albums: Album[];
    onPlay: (albumId: string) => Promise<void>;
    onDelete: (albumId: string, albumTitle: string) => void;
    isLoading?: boolean;
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
            () => onPlay(album.id),
            [album.id, onPlay]
        );
        const handleDelete = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(album.id, album.title);
            },
            [album.id, album.title, onDelete]
        );

        return (
            <div className="relative group">
                <PlayableCard
                    href={`/album/${album.id}`}
                    coverArt={
                        album.coverArt
                            ? api.getCoverArtUrl(album.coverArt, 300)
                            : null
                    }
                    title={album.title}
                    subtitle={album.artist?.name}
                    placeholderIcon={
                        <Disc3 className="w-10 h-10 text-gray-600" />
                    }
                    circular={false}
                    onPlay={handlePlay}
                    data-tv-card
                    data-tv-card-index={index}
                    tabIndex={0}
                />
                {/* Delete button - only visible on hover */}
                <button
                    onClick={handleDelete}
                    className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60  flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all z-10"
                    title="Delete album"
                >
                    <Trash2 className="w-3.5 h-3.5 text-white" />
                </button>
            </div>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.album.id === nextProps.album.id;
    }
);

const AlbumsGrid = memo(function AlbumsGrid({
    albums,
    onPlay,
    onDelete,
    isLoading = false,
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
            data-tv-section="library-albums"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4"
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
