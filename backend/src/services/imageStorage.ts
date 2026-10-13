/**
 * Image Storage Service
 *
 * Downloads and stores images locally for fast serving.
 * Images are stored in the covers directory and served directly from disk.
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { config, USER_AGENT } from "../config";

const ARTIST_IMAGES_DIR = "artists";
const ALBUM_IMAGES_DIR = "albums";
const PLAYLIST_IMAGES_DIR = "playlists";
const PLAYLIST_COVER_SIZE = 1000;

/**
 * Get the base covers directory path
 */
function getCoversBasePath(): string {
    return path.join(config.music.transcodeCachePath, "../covers");
}

/**
 * Ensure the covers directory exists
 */
function ensureCoversDir(subdir: string): string {
    const dirPath = path.join(getCoversBasePath(), subdir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logger.debug(`[ImageStorage] Created directory: ${dirPath}`);
    }
    return dirPath;
}

/** The path under the covers directory, or null when it escapes that directory. */
function resolveInCoversDir(relativePath: string): string | null {
    const basePath = getCoversBasePath();
    const resolvedBase = path.resolve(basePath);
    const fullPath = path.resolve(basePath, relativePath);
    if (!fullPath.startsWith(resolvedBase + path.sep) && fullPath !== resolvedBase) {
        return null;
    }
    return fullPath;
}

/**
 * Download an image from URL and save locally
 * Returns the native path (e.g., "native:artists/artistId.jpg") or null on failure
 */
export async function downloadAndStoreImage(
    url: string,
    id: string,
    type: "artist" | "album"
): Promise<string | null> {
    if (!url) return null;

    const subdir = type === "artist" ? ARTIST_IMAGES_DIR : ALBUM_IMAGES_DIR;
    const dirPath = ensureCoversDir(subdir);
    const filename = `${id}.jpg`;
    const filePath = path.join(dirPath, filename);

    try {
        logger.debug(`[ImageStorage] Downloading ${type} image: ${url.substring(0, 60)}...`);

        const response = await fetch(url, {
            headers: {
                "User-Agent": USER_AGENT,
            },
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            logger.debug(`[ImageStorage] Failed to download: ${response.status}`);
            return null;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) {
            logger.debug(`[ImageStorage] Not an image: ${contentType}`);
            return null;
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength < 1000) {
            logger.debug(`[ImageStorage] Image too small (${buffer.byteLength} bytes), likely placeholder`);
            return null;
        }

        await fs.promises.writeFile(filePath, Buffer.from(buffer));
        logger.debug(`[ImageStorage] Saved ${type} image: ${filename}`);

        return `native:${subdir}/${filename}`;
    } catch (error: any) {
        logger.debug(`[ImageStorage] Download failed: ${error.message}`);
        return null;
    }
}

/**
 * Store an uploaded playlist cover image (issue #151). The input is
 * square-cropped (center) and written as a progressive JPEG, never
 * upscaled: the side length is min(width, height, PLAYLIST_COVER_SIZE),
 * so a 1600x800 input becomes 800x800 and a 2000x1500 input 1000x1000.
 * Returns the native path ("native:playlists/<id>.jpg") served by
 * /api/library/cover-art. Re-uploads overwrite the previous file, so no
 * orphaned images accumulate.
 *
 * Throws when the buffer is not a decodable image.
 */
export async function storePlaylistCover(buffer: Buffer, playlistId: string): Promise<string> {
    const safeId = playlistId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dirPath = ensureCoversDir(PLAYLIST_IMAGES_DIR);
    const filename = `${safeId}.jpg`;
    const filePath = path.join(dirPath, filename);

    const sharp = (await import("sharp")).default;
    const metadata = await sharp(buffer, { failOn: "error" }).metadata();
    // Square side: the shorter input side, capped at PLAYLIST_COVER_SIZE, so
    // fit:"cover" crops without ever enlarging (sharp refuses to upscale when
    // withoutEnlargement is set, which would leave the output non-square).
    const size = Math.min(metadata.width ?? PLAYLIST_COVER_SIZE, metadata.height ?? PLAYLIST_COVER_SIZE, PLAYLIST_COVER_SIZE);

    await sharp(buffer, { failOn: "error" })
        .resize(size, size, {
            fit: "cover",
            withoutEnlargement: true,
        })
        .jpeg({ quality: 85, progressive: true })
        .toFile(filePath);

    logger.debug(`[ImageStorage] Saved playlist cover: ${filename}`);
    return `native:${PLAYLIST_IMAGES_DIR}/${filename}`;
}

/**
 * Get the full filesystem path for a native image path, or null when it is not
 * a native path, escapes the covers directory, or points at no file.
 */
export function getLocalImagePath(nativePath: string): string | null {
    if (!nativePath.startsWith("native:")) return null;

    const fullPath = resolveInCoversDir(nativePath.replace("native:", ""));
    return fullPath && fs.existsSync(fullPath) ? fullPath : null;
}

/** Whether a native image path points to an existing file on disk. */
export function nativeFileExists(nativePath: string | null | undefined): boolean {
    return nativePath ? getLocalImagePath(nativePath) !== null : false;
}

/**
 * Check for a local artist image file in the artist's music directory.
 * Copies to the image cache if found and returns a native path.
 */
async function checkLocalArtistImage(
    musicPath: string,
    artistDirName: string,
    artistId: string
): Promise<string | null> {
    const artistDir = path.join(musicPath, artistDirName);

    // Path traversal containment: ensure the resolved artist dir is inside musicPath
    const resolvedMusicPath = path.resolve(musicPath);
    const resolvedArtistDir = path.resolve(musicPath, artistDirName);
    if (!resolvedArtistDir.startsWith(resolvedMusicPath + path.sep)) {
        return null;
    }

    const candidates = [
        "artist.jpg", "artist.png", "artist.webp",
        "folder.jpg", "folder.png", "folder.webp",
    ];

    for (const filename of candidates) {
        const filePath = path.join(artistDir, filename);
        try {
            const lstat = await fs.promises.lstat(filePath);
            if (lstat.isSymbolicLink()) continue;
            if (lstat.isFile() && lstat.size > 1000) {
                const dirPath = ensureCoversDir(ARTIST_IMAGES_DIR);
                const ext = path.extname(filename);
                const cachePath = path.join(dirPath, `${artistId}${ext}`);
                await fs.promises.copyFile(filePath, cachePath);
                logger.debug(`[ImageStorage] Local artist image found: ${filePath}`);
                return `native:${ARTIST_IMAGES_DIR}/${artistId}${ext}`;
            }
        } catch {
            // Most candidate names do not exist; try the next.
        }
    }
    return null;
}

/**
 * An artist image in a folder above one of the artist's tracks (`relativeTrackPath`,
 * relative to the music folder), nearest folder first.
 */
export async function findLocalArtistImage(
    musicPath: string,
    relativeTrackPath: string,
    artistId: string
): Promise<string | null> {
    const parts = relativeTrackPath.split(path.sep);
    for (let i = parts.length - 2; i >= 0; i--) {
        const found = await checkLocalArtistImage(musicPath, parts.slice(0, i + 1).join(path.sep), artistId);
        if (found) return found;
    }
    return null;
}

/**
 * Check if a URL is a native local path
 */
export function isNativePath(url: string | null | undefined): boolean {
    if (!url) return false;
    return url.startsWith("native:");
}

/**
 * Resize an image buffer to the given width, preserving aspect ratio.
 * Returns the resized buffer as JPEG, or the original buffer if resizing fails.
 */
export async function resizeImageBuffer(
    buffer: Buffer,
    width: number
): Promise<Buffer> {
    // Skip resizing if width is unreasonably large or small
    if (width < 16 || width > 2048) return buffer;

    try {
        const sharp = (await import("sharp")).default;
        const metadata = await sharp(buffer).metadata();

        // Skip if image is already smaller than requested width
        if (metadata.width && metadata.width <= width) return buffer;

        return await sharp(buffer)
            .resize(width, undefined, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85, progressive: true })
            .toBuffer();
    } catch (err: any) {
        logger.warn(`[ImageStorage] Resize failed: ${err.message}`);
        return buffer;
    }
}

/**
 * Get the path for a resized version of a native image.
 * Format: {basePath}/{subdir}/{id}_w{width}.jpg
 */
export function getResizedImagePath(nativePath: string, width: number): string | null {
    if (!nativePath.startsWith("native:")) return null;

    const relativePath = nativePath.replace("native:", "");
    const parsed = path.parse(relativePath);
    return resolveInCoversDir(path.join(parsed.dir, `${parsed.name}_w${width}.jpg`));
}
