"use client";

import { useMemo } from "react";
import { Download, CheckCircle, Music } from "lucide-react";
import { LibraryTracksList } from "./LibraryTracksList";
import { describeResult, getQualityBadge, qualityScore, resultKey } from "./soulseekHelpers";
import type { LibraryTrack, SoulseekResult } from "../types";
import { usePublicConfig } from "@/hooks/useQueries";
import { ACQUIRE_LOCKED, ACQUIRE_LOCKED_LABEL } from "@/lib/acquire";

interface UnifiedSongsListProps {
    tracks: LibraryTrack[];
    soulseekResults: SoulseekResult[];
    downloadingFiles: Set<string>;
    onDownload: (result: SoulseekResult) => void;
}

/** At most six rows: up to four of the library's songs, Soulseek's best files after them. */
const MAX_ROWS = 6;
const MAX_LIBRARY = 4;

export function UnifiedSongsList({
    tracks,
    soulseekResults,
    downloadingFiles,
    onDownload,
}: UnifiedSongsListProps) {
    // Disabled until the server answers; the operator-only message only once it has said no.
    const { canAcquire, locked } = usePublicConfig();
    const librarySlice = tracks.slice(0, MAX_LIBRARY);
    const soulseekSlots = MAX_ROWS - librarySlice.length;
    const soulseekSlice = useMemo(
        () => [...soulseekResults].sort((a, b) => qualityScore(b) - qualityScore(a)).slice(0, Math.max(0, soulseekSlots)),
        [soulseekResults, soulseekSlots],
    );

    if (librarySlice.length === 0 && soulseekSlice.length === 0) {
        return null;
    }

    return (
        <div className="space-y-1">
            <LibraryTracksList tracks={tracks} limit={MAX_LIBRARY} />

            {soulseekSlice.map((result, index) => {
                const parsed = describeResult(result);
                const downloadKey = resultKey(result);
                const isDownloading = downloadingFiles.has(downloadKey);

                return (
                    <div
                        key={`slsk-${result.username}-${result.filename}-${index}`}
                        className="flex items-center gap-3 p-2 rounded-md hover:bg-white/5 transition-colors"
                    >
                        <button
                            onClick={() => canAcquire && !isDownloading && onDownload(result)}
                            disabled={!canAcquire || isDownloading}
                            title={locked ? ACQUIRE_LOCKED : "download"}
                            aria-label={locked ? ACQUIRE_LOCKED_LABEL : "download from soulseek"}
                            className="w-10 h-10 flex items-center justify-center flex-shrink-0 disabled:opacity-40"
                        >
                            {isDownloading ? (
                                <CheckCircle className="w-4 h-4 text-success" />
                            ) : (
                                <Download className="w-4 h-4 text-brand" />
                            )}
                        </button>

                        <div className="w-10 h-10 bg-[#181818] rounded flex items-center justify-center flex-shrink-0">
                            <Music className="w-5 h-5 text-[var(--text-secondary)]" />
                        </div>

                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-white truncate">
                                {parsed.title}
                            </p>
                            <p className="text-xs text-[var(--text-secondary)] truncate">
                                {parsed.artist}
                            </p>
                        </div>

                        <div className="flex-shrink-0">
                            {getQualityBadge(result)}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
