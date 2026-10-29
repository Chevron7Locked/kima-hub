import { Download, ListPlus } from "lucide-react";
import { cn } from "@/lib/cn";
import { MediaActionBar, MediaActionButton } from "@/components/ui/MediaActionBar";
import type { Album, AlbumSource } from "../types";

interface AlbumActionBarProps {
    album: Album;
    source: AlbumSource;
    onPlayAll: () => void;
    onShuffle: () => void;
    /** Absent for someone who may not start downloads: no download button then. */
    onDownloadAlbum?: () => void;
    onAddToPlaylist: () => void;
    isPendingDownload: boolean;
    isPlaying: boolean;
    isPlayingThisAlbum: boolean;
    onPause: () => void;
}

export function AlbumActionBar({
    album,
    source,
    onPlayAll,
    onShuffle,
    onDownloadAlbum,
    onAddToPlaylist,
    isPendingDownload,
    isPlaying,
    isPlayingThisAlbum,
    onPause,
}: AlbumActionBarProps) {
    const isOwned = album.owned !== undefined ? album.owned : source === "library";
    const showDownload = !isOwned && (album.mbid || album.rgMbid) && onDownloadAlbum;
    const showPause = isPlaying && isPlayingThisAlbum;

    return (
        <MediaActionBar
            showPlay={isOwned}
            showPause={showPause}
            onPlayPause={showPause ? onPause : onPlayAll}
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
