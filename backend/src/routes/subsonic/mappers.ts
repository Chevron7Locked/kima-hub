// Mappers from Prisma models to Subsonic response shapes. `@_` marks XML
// attributes for fast-xml-parser; subsonicResponse.ts strips it for JSON.
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
    /** The title as edited in Kima, shown in place of the file's title. */
    displayTitle: string | null;
    trackNo: number | null;
    discNumber: number | null;
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
        "@_title": track.displayTitle || track.title,
        "@_album": album.displayTitle || album.title,
        "@_artist": artistName,
        "@_isDir": false,
        "@_coverArt": album.id,
        "@_duration": track.duration ? Math.round(track.duration) : 0,
        "@_bitRate": estimateBitrateFromMime(track.mime),
        "@_track": track.trackNo || undefined,
        "@_discNumber": track.discNumber ?? undefined,
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
// Only a JSON array counts as a list of genres, as in the genre filters (utils/genreSql.ts): a bare string or an
// object in either column is none.
export function firstArtistGenre(genres: unknown, userGenres: unknown): string | undefined {
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((g): g is string => typeof g === "string") : []);
    const user = list(userGenres);
    return (user.length > 0 ? user : list(genres)).find((g) => g && !g.startsWith("_"));
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
    if (m.includes("opus")) return 128;
    return 192;
}

const SUFFIXES: Record<string, string> = {
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

/** The suffix for a mime type Kima knows, or null for none or one it does not. */
export function knownSuffix(mime: string | null): string | null {
    const m = normalizeMime(mime);
    return m && Object.prototype.hasOwnProperty.call(SUFFIXES, m) ? SUFFIXES[m] : null;
}

function mimeToSuffix(mime: string | null): string {
    return knownSuffix(mime) ?? "mp3";
}

type StreamQuality = "original" | "high" | "medium" | "low";
type Tier = Exclude<StreamQuality, "original">;

/** A client's maxBitRate in kbps, or null for none (absent, 0 or not a number). */
export function capKbps(maxBitRate: string | undefined): number | null {
    const br = parseInt(maxBitRate || "0", 10);
    return br > 0 ? br : null;
}

/** The highest MP3 tier (high 320, medium 192, low 128 kbps; audioStreaming.ts QUALITY_SETTINGS) within a cap. A cap
 * under 128 has none; this answers low, and the caller decides whether that is acceptable. */
export function tierFor(cap: number): Tier {
    if (cap >= 320) return "high";
    if (cap >= 192) return "medium";
    return "low";
}

/** The lowest MP3 bitrate Kima makes. */
export const LOWEST_TIER_KBPS = 128;

/** An MP3 Kima makes for a Subsonic client. */
export interface SubsonicServe {
    quality: Tier;
    /** The client asked for MP3: a file in another format is never served as it is. */
    mp3Only: boolean;
    /** The client's cap: a file within it is still served as it is (a FLAC under a 1000 cap). */
    capKbps: number | null;
}

/** The transcodeParams for direct play: the file as it is. */
export const DIRECT_PARAMS = "q-original";

/** getTranscodeDecision's opaque transcodeParams for an MP3 it will make. */
export function transcodeParamsFor(serve: SubsonicServe): string {
    return `${serve.mp3Only ? "mp3" : "q"}-${serve.quality}${serve.capKbps === null ? "" : `-${serve.capKbps}`}`;
}

/**
 * What a transcodeParams value names: "direct", an MP3, or null when it is not exactly a value the decision hands out
 * (a cap must match its tier and be at least 128; an uncapped MP3 is only the top tier asked for as mp3).
 */
export function serveFromTranscodeParams(value: string): "direct" | SubsonicServe | null {
    if (value === DIRECT_PARAMS) return "direct";
    const match = /^(q|mp3)-(high|medium|low)(?:-(\d{1,5}))?$/.exec(value);
    if (!match) return null;
    const mp3Only = match[1] === "mp3";
    const quality = match[2] as Tier;
    const cap = match[3] ? Number(match[3]) : null;
    const valid = cap === null ? mp3Only && quality === "high" : cap >= LOWEST_TIER_KBPS && tierFor(cap) === quality;
    return valid ? { quality, mp3Only, capKbps: cap } : null;
}

/** A song's format as Kima lists it to clients (getSong's suffix) when its mime is a known one, else its file
 * extension. */
export function songFormat(track: { mime: string | null; filePath: string | null }): string {
    const known = knownSuffix(track.mime);
    if (known) return known;
    const dot = (track.filePath ?? "").lastIndexOf(".");
    return dot >= 0 ? (track.filePath ?? "").slice(dot + 1).toLowerCase() : "";
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

export function parseRepeatedQueryParam(raw: unknown): string[] {
    return Array.isArray(raw) ? (raw as string[]) : raw ? [raw as string] : [];
}
