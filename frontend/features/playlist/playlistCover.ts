// Shared client-side validation for custom playlist cover uploads (issue #151).
// Mirrors the backend contract in backend/src/routes/playlists.ts: JPEG/PNG/WebP
// only, 10 MB max.

export const COVER_ACCEPT = "image/jpeg,image/png,image/webp";
export const COVER_MAX_BYTES = 10 * 1024 * 1024;

const COVER_TYPES = ["image/jpeg", "image/png", "image/webp"];
const COVER_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

/** Minimal File surface so the check works in tests and non-DOM contexts. */
type FileLike = { type: string; name: string; size: number };

/**
 * Whether a file is acceptable as a playlist cover. Browsers usually report
 * the MIME type correctly, but some (notably some Android/TV file pickers)
 * report an empty type -- the extension check is the fallback for those.
 */
export function isCoverImage(file: FileLike): boolean {
    if (COVER_TYPES.includes(file.type)) return true;
    if (file.type) return false; // a non-empty type that is not a cover type
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return COVER_EXTENSIONS.includes(ext);
}

/**
 * Validation message for a cover upload attempt, or null when the file is
 * acceptable. Used by both the playlist grid (context menu) and the playlist
 * detail page before hitting the API.
 */
export function coverUploadError(file: FileLike): string | null {
    if (!isCoverImage(file)) {
        return "Only JPEG, PNG and WebP images are supported";
    }
    if (file.size > COVER_MAX_BYTES) {
        return "Image is larger than 10 MB";
    }
    return null;
}
