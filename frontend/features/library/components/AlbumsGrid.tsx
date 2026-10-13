import { memo } from "react";
import { Album } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { MediaCard } from "@/components/cards/MediaCard";
import { Disc3, Play } from "lucide-react";
import { api } from "@/lib/api";
import { cascadeStyle } from "@/lib/motion";

interface AlbumsGridProps {
    albums: Album[];
    onPlay: (albumId: string) => Promise<void>;
    onDelete?: (albumId: string, albumTitle: string) => void;
    /** The mood each album shares with its tracks, from the vibe map. */
    moodByKey?: Map<string, string>;
    isLoading?: boolean;
    gridKey?: number;
}

interface AlbumCardItemProps {
    album: Album;
    index: number;
    onPlay: (albumId: string) => Promise<void>;
    onDelete?: (albumId: string, albumTitle: string) => void;
    moodKey?: string;
}

const AlbumCardItem = memo(
    function AlbumCardItem({
        album,
        index,
        onPlay,
        onDelete,
        moodKey,
    }: AlbumCardItemProps) {
        return (
            <MediaCard
                href={`/album/${album.id}`}
                title={album.title}
                subtitle={album.artist?.name}
                imageUrl={album.coverArt ? api.getCoverArtUrl(album.coverArt, 200) : null}
                fallbackIcon={Disc3}
                type="album"
                index={index}
                action={{ icon: Play, label: "Play", onClick: () => onPlay(album.id) }}
                moodKey={moodKey}
                onDelete={onDelete ? () => onDelete(album.id, album.title) : undefined}
            />
        );
    },
    (prevProps, nextProps) => {
        // The mood arrives later than the album; a same-id card must still update for it.
        return prevProps.album.id === nextProps.album.id && prevProps.moodKey === nextProps.moodKey;
    },
);

const AlbumsGrid = memo(function AlbumsGrid({
    albums,
    onPlay,
    onDelete,
    moodByKey,
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
            style={cascadeStyle(albums.length)}
        >
            {albums.map((album, index) => (
                <AlbumCardItem
                    key={album.id}
                    album={album}
                    index={index}
                    onPlay={onPlay}
                    onDelete={onDelete}
                    moodKey={moodByKey?.get(album.id)}
                />
            ))}
        </div>
    );
});

export { AlbumsGrid };
