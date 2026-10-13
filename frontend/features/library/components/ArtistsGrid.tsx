import { memo } from "react";
import { Music, Play } from "lucide-react";
import { Artist } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { MediaCard } from "@/components/cards/MediaCard";
import { cascadeStyle } from "@/lib/motion";
import { plural } from "@/lib/format";

interface ArtistsGridProps {
    artists: Artist[];
    onPlay: (artistId: string) => Promise<void>;
    onDelete?: (artistId: string, artistName: string) => void;
    /** The mood each artist shares with their tracks, from the vibe map. */
    moodByKey?: Map<string, string>;
    isLoading?: boolean;
    gridKey?: number;
}

interface ArtistCardItemProps {
    artist: Artist;
    index: number;
    onPlay: (artistId: string) => Promise<void>;
    onDelete?: (artistId: string, artistName: string) => void;
    moodKey?: string;
}

const ArtistCardItem = memo(
    function ArtistCardItem({
        artist,
        index,
        onPlay,
        onDelete,
        moodKey,
    }: ArtistCardItemProps) {
        return (
            <MediaCard
                href={`/artist/${artist.id}`}
                title={artist.name}
                subtitle={plural(artist.albumCount || 0, "album")}
                imageUrl={artist.coverArt ? api.getCoverArtUrl(artist.coverArt, 200) : null}
                fallbackIcon={Music}
                type="artist"
                index={index}
                action={{ icon: Play, label: "Play", onClick: () => onPlay(artist.id) }}
                moodKey={moodKey}
                onDelete={onDelete ? () => onDelete(artist.id, artist.name) : undefined}
            />
        );
    },
    (prevProps, nextProps) => {
        // The mood arrives later than the artist; a same-id card must still update for it.
        return prevProps.artist.id === nextProps.artist.id && prevProps.moodKey === nextProps.moodKey;
    },
);

const ArtistsGrid = memo(function ArtistsGrid({
    artists,
    onPlay,
    onDelete,
    moodByKey,
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
            style={cascadeStyle(artists.length)}
        >
            {artists.map((artist, index) => (
                <ArtistCardItem
                    key={artist.id}
                    artist={artist}
                    index={index}
                    onPlay={onPlay}
                    onDelete={onDelete}
                    moodKey={moodByKey?.get(artist.id)}
                />
            ))}
        </div>
    );
});

export { ArtistsGrid };
