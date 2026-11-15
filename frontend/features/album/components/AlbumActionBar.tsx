import { Download, ListPlus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { MediaActionBar, MediaActionButton } from "@/components/ui/MediaActionBar";
import { usePlayRow } from "@/hooks/usePlayRow";
import { queueSource, useQueueFrom } from "@/lib/queue-source";
import type { Album, AlbumSource } from "../types";

interface AlbumActionBarProps {
    album: Album;
    source: AlbumSource;
    onPlayAll: () => void;
    onShuffle: () => void;
    /** Absent for someone who may not start downloads: no download button then. */
    onDownloadAlbum?: () => void;
    onAddToPlaylist: () => void;
    /** Absent unless the viewer may delete this library album: no delete button then. */
    onDelete?: () => void;
    isPendingDownload: boolean;
}

export function AlbumActionBar({
    album,
    source,
    onPlayAll,
    onShuffle,
    onDownloadAlbum,
    onAddToPlaylist,
    onDelete,
    isPendingDownload,
}: AlbumActionBarProps) {
    const { isPlaying, playRow } = usePlayRow();
    // Current only while the loaded queue came from this album's play button, not whenever one of its songs is loaded.
    const isPlayingThisAlbum = useQueueFrom(queueSource.album(album.id));
    const isOwned = album.owned !== undefined ? album.owned : source === "library";
    const showDownload = !isOwned && (album.mbid || album.rgMbid) && onDownloadAlbum;
    const showPause = isPlaying && isPlayingThisAlbum;

    return (
        <MediaActionBar
            showPlay={isOwned}
            showPause={showPause}
            // This album pauses or resumes where it is; otherwise the button starts it.
            onPlayPause={() => playRow(isPlayingThisAlbum, onPlayAll)}
            onShuffle={onShuffle}
            secondaryShape="square"
        >
            {isOwned && (
                <MediaActionButton
                    shape="square"
                    icon={<ListPlus className="w-5 h-5" />}
                    label="add to playlist"
                    onClick={onAddToPlaylist}
                />
            )}

            {isOwned && onDelete && (
                <MediaActionButton
                    shape="square"
                    icon={<Trash2 className="w-5 h-5" />}
                    label="delete album"
                    onClick={onDelete}
                />
            )}

            {showDownload && (
                <button
                    onClick={onDownloadAlbum}
                    disabled={isPendingDownload}
                    className={cn(
                        "flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-all",
                        isPendingDownload
                            ? "bg-white/5 text-[var(--text-secondary)] cursor-not-allowed"
                            : "bg-brand hover:bg-brand-hover text-black hover:scale-105"
                    )}
                >
                    <Download className="w-4 h-4" />
                    <span>
                        {isPendingDownload ? "Downloading..." : "Download"}
                    </span>
                </button>
            )}
        </MediaActionBar>
    );
}
