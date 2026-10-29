import type { SoulseekResult } from "../types";

export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const getQualityBadge = (result: SoulseekResult) => {
    if (result.format === "flac") {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-purple-600/20 text-purple-400 rounded">
                FLAC
            </span>
        );
    }
    if (result.bitrate >= 320) {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-success/20 text-success rounded">
                320 kbps
            </span>
        );
    }
    if (result.bitrate >= 256) {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-blue-600/20 text-blue-400 rounded">
                256 kbps
            </span>
        );
    }
    return (
        <span className="px-2 py-1 text-xs font-semibold bg-gray-600/20 text-[var(--text-secondary)] rounded">
            {result.bitrate} kbps
        </span>
    );
};

const parseFilename = (
    filename: string,
): { artist: string; title: string } => {
    const match = filename.match(/([^/\\]+)\.(?:mp3|flac|m4a|wav)$/i);
    if (match) {
        const nameWithoutExt = match[1];
        const parts = nameWithoutExt.split(" - ");
        if (parts.length >= 2) {
            return {
                artist: parts[0].trim(),
                title: parts.slice(1).join(" - ").trim(),
            };
        }
        return { artist: "Unknown", title: nameWithoutExt };
    }
    return { artist: "Unknown", title: filename };
};

/** A result's identity for downloads and selection: the peer and the file's path on it. */
export const resultKey = (result: SoulseekResult) => `${result.username}:${result.path}`;

/** Lossless first, then by bitrate. */
export const qualityScore = (result: SoulseekResult) => (result.format === "flac" ? 10000 : result.bitrate);

/**
 * A result's artist and title: the server's parse where it has one; with only the artist parsed, the title is what
 * follows the first " - " in the file name; with neither, both are read from the file name.
 */
export function describeResult(result: SoulseekResult): { artist: string; title: string } {
    if (result.parsedTitle) return { artist: result.parsedArtist || "Unknown", title: result.parsedTitle };
    if (result.parsedArtist) {
        const title = result.filename.split("\\").pop()?.split(" - ").slice(1).join(" - ");
        return { artist: result.parsedArtist, title: title || result.filename };
    }
    return parseFilename(result.filename);
}
