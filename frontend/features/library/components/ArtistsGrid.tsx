import React, { memo, useCallback } from "react";
import { Music, Trash2 } from "lucide-react";
import { Artist } from "../types";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { api } from "@/lib/api";

interface ArtistsGridProps {
    artists: Artist[];
    onPlay: (artistId: string) => Promise<void>;
    onDelete: (artistId: string, artistName: string) => void;
    isLoading?: boolean;
}

const getArtistImageSrc = (coverArt?: string): string | null => {
    if (!coverArt) return null;
    return api.getCoverArtUrl(coverArt, 300);
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
            () => onPlay(artist.id),
            [artist.id, onPlay]
        );
        const handleDelete = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(artist.id, artist.name);
            },
            [artist.id, artist.name, onDelete]
        );

        return (
            <div className="relative group">
                <PlayableCard
                    href={`/artist/${artist.mbid || artist.id}`}
                    coverArt={getArtistImageSrc(artist.coverArt)}
                    title={artist.name}
                    subtitle={`${artist.albumCount || 0} albums`}
                    placeholderIcon={
                        <Music className="w-10 h-10 text-gray-600" />
                    }
                    circular={true}
                    onPlay={handlePlay}
                    data-tv-card
                    data-tv-card-index={index}
                    tabIndex={0}
                />
                {/* Delete button - only visible on hover */}
                <button
                    onClick={handleDelete}
                    className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 hidden md:flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-all z-10"
                    title="Delete artist"
                >
                    <Trash2 className="w-3.5 h-3.5 text-white" />
                </button>
            </div>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.artist.id === nextProps.artist.id;
    }
);

const ArtistsGrid = memo(function ArtistsGrid({
    artists,
    onPlay,
    onDelete,
    isLoading = false,
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
            data-tv-section="library-artists"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4"
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
