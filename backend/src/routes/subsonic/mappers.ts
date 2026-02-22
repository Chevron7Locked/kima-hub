// backend/src/routes/subsonic/mappers.ts
// Shared mapper functions used across all Subsonic route files.
// These convert Kima's Prisma models to Subsonic API response shapes.
// The @_ prefix convention is used by fast-xml-parser for XML attributes.
// subsonicResponse.ts strips these prefixes for JSON output automatically.
import { Request, Response } from "express";
import { subsonicError, SubsonicError } from "../../utils/subsonicResponse";

export type ArtistRow = {
    id: string;
    name: string;
    displayName: string | null;
    heroUrl: string | null;
    albumCount?: number;
};

export type AlbumRow = {
    id: string;
    title: string;
    displayTitle: string | null;
    year: number | null;
    coverUrl: string | null;
    userCoverUrl?: string | null;
    artistId: string;
    songCount?: number;
    duration?: number;
    genre?: string | null;
};

export type TrackRow = {
    id: string;
    title: string;
    trackNo: number | null;
    duration: number | null;
    filePath: string | null;
    mime: string | null;
    fileSize: number | null;
};

export function mapArtist(a: ArtistRow) {
    return {
        "@_id": a.id,
        "@_name": a.displayName || a.name,
        "@_albumCount": a.albumCount ?? 0,
        "@_coverArt": `ar-${a.id}`,
        "@_artistImageUrl": a.heroUrl || undefined,
    };
}

export function mapAlbum(album: AlbumRow, artistName: string) {
    return {
        "@_id": album.id,
        "@_name": album.displayTitle || album.title,
        "@_artist": artistName,
        "@_artistId": album.artistId,
        "@_coverArt": album.id,
        "@_songCount": album.songCount ?? 0,
        "@_duration": album.duration !== undefined ? Math.round(album.duration) : 0,
        "@_year": album.year || undefined,
        "@_genre": album.genre || undefined,
    };
}

export function mapSong(
    track: TrackRow,
    album: { id: string; title: string; displayTitle: string | null; year: number | null },
    artistName: string,
    artistId: string,
    genre?: string | null
) {
    return {
        "@_id": track.id,
        "@_parent": album.id,
        "@_title": track.title,
        "@_album": album.displayTitle || album.title,
        "@_artist": artistName,
        "@_isDir": false,
        "@_coverArt": album.id,
        "@_duration": track.duration ? Math.round(track.duration) : 0,
        "@_bitRate": estimateBitrateFromMime(track.mime),
        "@_track": track.trackNo || undefined,
        "@_year": album.year || undefined,
        "@_size": track.fileSize ?? undefined,
        "@_contentType": normalizeMime(track.mime) || "audio/mpeg",
        "@_suffix": mimeToSuffix(track.mime),
        "@_albumId": album.id,
        "@_artistId": artistId,
        "@_type": "music",
        "@_genre": genre || undefined,
    };
}

// Extract the first genre string from an artist's enriched genre array.
// Prefers userGenres override; falls back to enrichment genres.
// Tags starting with "_" are internal markers (e.g. "_no_mood_tags") — filtered out.
export function firstArtistGenre(genres: unknown, userGenres: unknown): string | undefined {
    const arr = ((userGenres as string[] | null)?.length
        ? (userGenres as string[])
        : (genres as string[] | null)) ?? [];
    return arr.find((g) => g && !g.startsWith("_"));
}

// Normalize codec names stored by the library scanner (e.g. "FLAC", "MPEG 1 Layer 3")
// to proper MIME types expected by Subsonic clients.
function normalizeMime(mime: string | null): string | null {
    if (!mime) return null;
    const upper = mime.toUpperCase();
    if (upper === "FLAC") return "audio/flac";
    if (upper.startsWith("MPEG")) return "audio/mpeg";
    if (upper === "AAC") return "audio/aac";
    if (upper === "OGG" || upper === "VORBIS") return "audio/ogg";
    if (upper === "OPUS") return "audio/opus";
    if (upper === "WAV") return "audio/wav";
    if (upper === "ALAC" || upper === "M4A") return "audio/mp4";
    return mime; // already a proper MIME type or unknown
}

function estimateBitrateFromMime(mime: string | null): number {
    const m = normalizeMime(mime);
    if (!m) return 192;
    if (m.includes("flac")) return 900;
    if (m.includes("wav")) return 1400;
    if (m.includes("aac") || m.includes("mp4")) return 256;
    if (m.includes("ogg") || m.includes("vorbis")) return 192;
    if (m.includes("opus")) return 128;
    return 192;
}

export function mimeToSuffix(mime: string | null): string {
    const m = normalizeMime(mime);
    if (!m) return "mp3";
    const map: Record<string, string> = {
        "audio/flac": "flac",
        "audio/x-flac": "flac",
        "audio/ogg": "ogg",
        "audio/vorbis": "ogg",
        "audio/mp4": "m4a",
        "audio/aac": "aac",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/opus": "opus",
    };
    return map[m] || "mp3";
}

export function bitrateToQuality(
    maxBitRate: string | undefined
): "original" | "high" | "medium" | "low" {
    const br = parseInt(maxBitRate || "0", 10);
    if (br === 0 || br >= 320) return "original";
    if (br >= 192) return "high";
    if (br >= 128) return "medium";
    return "low";
}

export function wrap(fn: (req: Request, res: Response) => Promise<void | Response>) {
    return (req: Request, res: Response) => {
        fn(req, res).catch((err: unknown) => {
            if (!res.headersSent) {
                const msg = err instanceof Error ? err.message : "Internal error";
                subsonicError(req, res, SubsonicError.GENERIC, msg);
            }
        });
    };
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function parseIntParam(raw: string | undefined, defaultVal: number): number {
    if (raw === undefined || raw === "") return defaultVal;
    const n = parseInt(raw, 10);
    return isNaN(n) ? defaultVal : n;
}
