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

        // Downscale oversized artwork before caching so we don't keep multi-MB
        // originals on disk and ship them to the browser.
        const original = Buffer.from(buffer);
        const toWrite = await downscaleForCache(original, type);
        await fs.promises.writeFile(filePath, toWrite);
        logger.debug(
            `[ImageStorage] Saved ${type} image: ${filename} (${original.byteLength} -> ${toWrite.byteLength} bytes)`
        );

        return `native:${subdir}/${filename}`;
    } catch (error: any) {
        logger.debug(`[ImageStorage] Download failed: ${error.message}`);
        return null;
    }
}

/**
 * Get the full filesystem path for a native image path
 */
export function getLocalImagePath(nativePath: string): string | null {
    if (!nativePath.startsWith("native:")) return null;

    const relativePath = nativePath.replace("native:", "");
    const basePath = getCoversBasePath();
    const resolvedBase = path.resolve(basePath);
    const fullPath = path.resolve(basePath, relativePath);

    if (!fullPath.startsWith(resolvedBase + path.sep) && fullPath !== resolvedBase) {
        return null;
    }

    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
}

/**
 * Check if a native image path points to an existing file on disk.
 * Returns false for non-native paths, null, or missing files.
 */
export function nativeFileExists(nativePath: string | null | undefined): boolean {
    if (!nativePath || !nativePath.startsWith("native:")) return false;

    const relativePath = nativePath.replace("native:", "");
    const basePath = getCoversBasePath();
    const resolvedBase = path.resolve(basePath);
    const fullPath = path.resolve(basePath, relativePath);

    if (!fullPath.startsWith(resolvedBase + path.sep) && fullPath !== resolvedBase) {
        return false;
    }

    return fs.existsSync(fullPath);
}


/**
 * Check for a local artist image file in the artist's music directory.
 * Copies to the image cache if found and returns a native path.
 */
export async function checkLocalArtistImage(
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
        } catch {}
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
 * Downscale an image buffer for on-disk caching: constrain the longest edge to
 * a per-type maximum (see config.artwork) and re-encode as JPEG. Only ever
 * shrinks — images already within budget are returned untouched. Falls back to
 * the original buffer on any failure so caching never breaks on a bad image.
 */
async function downscaleForCache(
    buffer: Buffer,
    type: "artist" | "album"
): Promise<Buffer> {
    const maxDim =
        type === "artist"
            ? config.artwork.maxArtistDim
            : config.artwork.maxAlbumDim;
    if (!maxDim || maxDim < 16) return buffer;

    try {
        const sharp = (await import("sharp")).default;
        const metadata = await sharp(buffer).metadata();
        const longestEdge = Math.max(metadata.width || 0, metadata.height || 0);

        // Already within budget — keep the original bytes untouched.
        if (longestEdge && longestEdge <= maxDim) return buffer;

        return await sharp(buffer)
            .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: config.artwork.quality, progressive: true })
            .toBuffer();
    } catch (err: any) {
        logger.warn(`[ImageStorage] Cache downscale failed: ${err.message}`);
        return buffer;
    }
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
    const resizedRelative = path.join(parsed.dir, `${parsed.name}_w${width}.jpg`);
    const basePath = getCoversBasePath();
    const resolvedBase = path.resolve(basePath);
    const fullPath = path.resolve(basePath, resizedRelative);

    if (!fullPath.startsWith(resolvedBase + path.sep) && fullPath !== resolvedBase) {
        return null;
    }

    return fullPath;
}
