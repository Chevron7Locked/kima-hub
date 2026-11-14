/** Downloads images into the covers folder, which is served straight from disk. */

import { fetchChecked } from "../utils/ssrf";
import fs from "fs";
import { createHash, randomUUID } from "crypto";
import path from "path";
import { logger } from "../utils/logger";
import { config, USER_AGENT } from "../config";

const ARTIST_IMAGES_DIR = "artists";
const ALBUM_IMAGES_DIR = "albums";

/** The largest picture stored: a download or a local file over it is skipped, so one cannot fill memory or disk. */
export const MAX_PICTURE_BYTES = 20 * 1024 * 1024;

/**
 * What a stored cover is served with. An address that carries a version (`native:albums/<id>.jpg?v=<version>`) names one
 * picture for good, because a changed cover is stored under a new version, so clients keep it for a year. An address with
 * none (stored before versions) can still change under it, so clients ask again each time (answered 304 while unchanged).
 */
export function coverCacheControl(version: string | null): string {
    return version ? "public, max-age=31536000, immutable" : "public, no-cache";
}

/** A short digest of a stored cover's bytes: it changes when the picture does, and not when the same picture is stored again. */
function coverVersion(bytes: Buffer): string {
    return createHash("sha1").update(bytes).digest("hex").slice(0, 10);
}

/** The version of the cover stored at `filePath` as it is now, or null when the file cannot be read. */
export async function versionOfFile(filePath: string): Promise<string | null> {
    try {
        return coverVersion(await fs.promises.readFile(filePath));
    } catch {
        return null;
    }
}

const VERSION_SUFFIX = /\?v=([A-Za-z0-9_-]{1,64})$/;

/** The address of a stored cover: its path under the covers folder, then its version when it has one. */
export function storedCoverValue(relativePath: string, version: string | null): string {
    return version ? `native:${relativePath}?v=${version}` : `native:${relativePath}`;
}

/**
 * A stored cover's address as its path under the covers folder and its version (null for an address stored before
 * versions), or null when it is not a stored cover's address. The version plays no part in finding the file.
 */
export function parseStoredCover(value: string | null | undefined): { relativePath: string; version: string | null } | null {
    if (!value?.startsWith("native:")) return null;
    const rest = value.slice("native:".length);
    const match = VERSION_SUFFIX.exec(rest);
    return match ? { relativePath: rest.slice(0, match.index), version: match[1] } : { relativePath: rest, version: null };
}

/**
 * The address clients load an audiobook's cover from, or null when the book has none. Its version is the digest of the
 * picture, taken when the sync stores the cover, so the address changes when the picture does and not when the book is
 * synced again. A book with no stored version yet (its cover is only at Audiobookshelf) has an address without one.
 */
export function audiobookCoverAddress(book: { id: string; localCoverPath: string | null; coverUrl: string | null; coverVersion: string | null }): string | null {
    if (!book.localCoverPath && !book.coverUrl) return null;
    return book.coverVersion ? `/audiobooks/${book.id}/cover/${book.coverVersion}` : `/audiobooks/${book.id}/cover`;
}

/** The folder stored covers live in, beside the transcode cache. */
export function coversBasePath(): string {
    return path.join(config.music.transcodeCachePath, "../covers");
}

/** The folder audiobook covers are cached in, under the music folder. */
export function audiobookCoversPath(): string {
    return path.join(config.music.musicPath, "cover-cache", "audiobooks");
}

/**
 * Ensure the covers directory exists
 */
function ensureCoversDir(subdir: string): string {
    const dirPath = path.join(coversBasePath(), subdir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logger.debug(`[ImageStorage] Created directory: ${dirPath}`);
    }
    return dirPath;
}

/** The path under the covers directory, or null when it escapes that directory. */
export function resolveInCoversDir(relativePath: string): string | null {
    const basePath = coversBasePath();
    const resolvedBase = path.resolve(basePath);
    const fullPath = path.resolve(basePath, relativePath);
    if (!fullPath.startsWith(resolvedBase + path.sep) && fullPath !== resolvedBase) {
        return null;
    }
    return fullPath;
}

/**
 * The picture as JPEG bytes: a JPEG that needs no turning as it came, anything else converted (turned upright by its
 * orientation tag, any transparency laid on white), null when the bytes are no picture. Every stored image is a `.jpg`
 * (readers look the file up by that name), so the bytes must be a JPEG, whatever the server's content type claimed.
 */
async function asJpeg(bytes: Buffer): Promise<Buffer | null> {
    try {
        const sharp = (await import("sharp")).default;
        if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
            const { orientation } = await sharp(bytes).metadata();
            if (!orientation || orientation === 1) return bytes;
        }
        return await sharp(bytes).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
    } catch {
        return null;
    }
}

/** A write that crashed leaves its temporary file; one this old cannot belong to a write still going. */
const ORPHAN_PART_AGE_MS = 10 * 60 * 1000;

/** Each folder is swept once per start, the first time it is written to; the promise is what a second write waits on. */
const sweptFolders = new Map<string, Promise<void>>();

/** Removes the `.part` files a crash left in `dir`. A failure only means they stay for the next start. */
function sweepOrphanParts(dir: string): Promise<void> {
    let swept = sweptFolders.get(dir);
    if (!swept) {
        swept = (async () => {
            try {
                const cutoff = Date.now() - ORPHAN_PART_AGE_MS;
                for (const name of await fs.promises.readdir(dir)) {
                    if (!name.endsWith(".part")) continue;
                    const file = path.join(dir, name);
                    try {
                        if ((await fs.promises.stat(file)).mtimeMs < cutoff) {
                            await fs.promises.rm(file, { force: true });
                            logger.debug(`[ImageStorage] Removed an orphan partial file: ${file}`);
                        }
                    } catch {
                        // Gone already, or not ours to remove: leave it.
                    }
                }
            } catch (err) {
                logger.debug(`[ImageStorage] Could not sweep ${dir}: ${(err as Error).message}`);
            }
        })();
        sweptFolders.set(dir, swept);
    }
    return swept;
}

/** What a file looked like when it was read: a later write to it changes one of these. */
export interface FileVersion {
    mtimeMs: number;
    size: number;
}

/**
 * Written under a temporary name and renamed into place, so a crash or a failed write never leaves half a file under
 * the final name, and a reader never finds one. The folder's orphan temporary files are swept before its first write.
 * With `readAs`, the file is replaced only if it still looks as it did then, else nothing changes and the answer
 * is false: a pass holding old bytes must not overwrite a newer write.
 */
async function writeAtomically(filePath: string, bytes: Buffer, readAs?: FileVersion): Promise<boolean> {
    await sweepOrphanParts(path.dirname(filePath));
    const partial = `${filePath}.${process.pid}.${randomUUID()}.part`;
    try {
        await fs.promises.writeFile(partial, bytes);
        if (readAs) {
            // A file deleted meanwhile counts as changed too: the pass does not bring it back.
            const now = await fs.promises.stat(filePath).catch(() => null);
            if (!now || now.mtimeMs !== readAs.mtimeMs || now.size !== readAs.size) {
                await fs.promises.rm(partial, { force: true });
                return false;
            }
        }
        await fs.promises.rename(partial, filePath);
        return true;
    } catch (err) {
        await fs.promises.rm(partial, { force: true });
        throw err;
    }
}

/**
 * The one way a stored picture is written: `bytes` as a JPEG (converted unless already one), atomically. Answers the
 * stored picture's version, and null (writing nothing) when the bytes are no picture; throws when the write fails,
 * leaving no partial file.
 */
export async function storeAsJpeg(filePath: string, bytes: Buffer): Promise<string | null> {
    const picture = await asJpeg(bytes);
    if (!picture) return null;
    await writeAtomically(filePath, picture);
    await dropResizedCopies(filePath);
    return coverVersion(picture);
}

/**
 * Removes the smaller copies (`<name>_w<width>.jpg`) of the cover stored at `filePath`, and no other file: they were
 * made from the cover's earlier bytes. A failure only leaves them, and `coverFileForWidth` makes a new copy whenever the
 * one on disk is older than its cover.
 */
async function dropResizedCopies(filePath: string): Promise<void> {
    const { dir, name } = path.parse(filePath);
    try {
        for (const file of await fs.promises.readdir(dir)) {
            if (file.startsWith(`${name}_w`) && /^\d+\.jpg$/.test(file.slice(name.length + 2))) {
                await fs.promises.rm(path.join(dir, file), { force: true });
            }
        }
    } catch (err) {
        logger.warn(`[ImageStorage] Could not remove the smaller copies of ${filePath}: ${(err as Error).message}`);
    }
}

/**
 * The body as bytes, or null when it is over `MAX_PICTURE_BYTES`: judged by its Content-Length first, then by the bytes
 * counted as they arrive (a length may be missing or false), and the download is cancelled at that point.
 */
export async function readCapped(response: Response): Promise<Buffer | null> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PICTURE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PICTURE_BYTES) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

const PROXIED_PICTURE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

/**
 * A picture a route proxies from another host: its bytes (read through `readCapped`) and its type, without parameters.
 * Null when it is over the cap or the host named no picture type, so the route answers not found rather than send a
 * stranger's page or an unbounded body to a browser under Kima's address. Only the types a browser draws as a plain
 * image are read: an SVG is a document that can carry script, and would run under Kima's address.
 */
export async function readPicture(response: Response): Promise<{ bytes: Buffer; contentType: string } | null> {
    const contentType = /^\s*(image\/[^\s;]+)/i.exec(response.headers.get("content-type") ?? "")?.[1]?.toLowerCase();
    if (!contentType || !PROXIED_PICTURE_TYPES.has(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    const bytes = await readCapped(response);
    return bytes ? { bytes, contentType } : null;
}

/**
 * A picture at an outside address, for a route that serves it as its own: fetched through the address guard with a time
 * limit and read as `readPicture` does. Null (with a warning) when the host cannot be reached or refuses, answers with
 * an error, is over the size cap or names no image type.
 */
export async function fetchPicture(url: string, timeoutMs = 15_000): Promise<{ bytes: Buffer; contentType: string } | null> {
    try {
        const response = await fetchChecked(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            return null;
        }
        const picture = await readPicture(response);
        if (!picture) logger.warn(`[ImageStorage] The reply from ${url.substring(0, 100)} is no image or is over the size cap`);
        return picture;
    } catch (err) {
        logger.warn(`[ImageStorage] Could not fetch ${url.substring(0, 100)}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

/**
 * Replaces a stored file with its bytes as a JPEG, unless the file was written to since `readAs` (its time and size
 * when `bytes` were read): then the newer write stands and nothing changes. Otherwise as `storeAsJpeg`.
 */
export async function replaceWithJpeg(
    filePath: string,
    bytes: Buffer,
    readAs: FileVersion,
): Promise<"replaced" | "notPicture" | "changed"> {
    const picture = await asJpeg(bytes);
    if (!picture) return "notPicture";
    return (await writeAtomically(filePath, picture, readAs)) ? "replaced" : "changed";
}

/**
 * Download an image from URL and save locally, as a JPEG
 * Returns the stored cover's address (e.g., "native:artists/artistId.jpg?v=<version>") or null on failure
 */
export async function downloadAndStoreImage(
    url: string,
    id: string,
    type: "artist" | "album",
    signal?: AbortSignal
): Promise<string | null> {
    if (!url) return null;
    // A stop ends the download at once; a download with no signal keeps its own 30 s limit.
    if (signal?.aborted) return null;

    const subdir = type === "artist" ? ARTIST_IMAGES_DIR : ALBUM_IMAGES_DIR;
    const dirPath = ensureCoversDir(subdir);
    const filename = `${id}.jpg`;
    const filePath = path.join(dirPath, filename);

    try {
        logger.debug(`[ImageStorage] Downloading ${type} image: ${url.substring(0, 60)}...`);

        const response = await fetchChecked(url, {
            headers: {
                "User-Agent": USER_AGENT,
            },
            signal: signal ? AbortSignal.any([AbortSignal.timeout(30000), signal]) : AbortSignal.timeout(30000),
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

        const buffer = await readCapped(response);
        if (!buffer) {
            logger.warn(`[ImageStorage] The ${type} image for ${id} is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB; skipped`);
            return null;
        }
        if (buffer.byteLength < 1000) {
            logger.debug(`[ImageStorage] Image too small (${buffer.byteLength} bytes), likely placeholder`);
            return null;
        }

        const version = await storeAsJpeg(filePath, buffer);
        if (!version) {
            logger.debug(`[ImageStorage] Not a readable picture despite its content type: ${contentType}`);
            return null;
        }
        logger.debug(`[ImageStorage] Saved ${type} image: ${filename}`);

        return storedCoverValue(`${subdir}/${filename}`, version);
    } catch (error: any) {
        logger.debug(`[ImageStorage] Download failed: ${error.message}`);
        return null;
    }
}

/**
 * Get the full filesystem path for a native image path, or null when it is not
 * a native path, escapes the covers directory, or points at no file.
 */
export function getLocalImagePath(nativePath: string): string | null {
    const cover = parseStoredCover(nativePath);
    if (!cover) return null;

    const fullPath = resolveInCoversDir(cover.relativePath);
    return fullPath && fs.existsSync(fullPath) ? fullPath : null;
}

/** Whether a native image path points to an existing file on disk. */
export function nativeFileExists(nativePath: string | null | undefined): boolean {
    return nativePath ? getLocalImagePath(nativePath) !== null : false;
}

/**
 * Check for a local artist image file in the artist's music directory.
 * Stores it in the image cache as a JPEG if found and returns a native path.
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
            if (lstat.isFile() && lstat.size > MAX_PICTURE_BYTES) {
                logger.warn(`[ImageStorage] Local artist image ${filePath} is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB; skipped`);
                continue;
            }
            if (lstat.isFile() && lstat.size > 1000) {
                const dirPath = ensureCoversDir(ARTIST_IMAGES_DIR);
                const stored = `${artistId}.jpg`;
                const version = await storeAsJpeg(path.join(dirPath, stored), await fs.promises.readFile(filePath));
                if (!version) {
                    logger.debug(`[ImageStorage] Not a readable picture: ${filePath}`);
                    continue;
                }
                logger.debug(`[ImageStorage] Local artist image found: ${filePath}`);
                return storedCoverValue(`${ARTIST_IMAGES_DIR}/${stored}`, version);
            }
        } catch {
            // Most candidate names do not exist, and a file that cannot be read or stored is passed over; try the next.
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
    const cover = parseStoredCover(nativePath);
    if (!cover) return null;

    const parsed = path.parse(cover.relativePath);
    return resolveInCoversDir(path.join(parsed.dir, `${parsed.name}_w${width}.jpg`));
}

/** The width a client's `size` (the raw query value) asks for: a whole number from 16 to 2048, else null (the whole picture). */
export function coverWidthOf(size: string | undefined): number | null {
    const width = size ? parseInt(size, 10) : 0;
    return width >= 16 && width <= 2048 ? width : null;
}

/**
 * The file to serve for a stored cover when a client sends `size` (the raw query value): the cover itself unless `size`
 * is a whole width from 16 to 2048, else `coverFileForWidth`. The one place those limits live for every route that serves
 * a stored cover. A copy that cannot be made leaves the cover itself, with a warning.
 */
export async function coverFileForSize(coverPath: string, relativePath: string, size: string | undefined): Promise<string> {
    const width = coverWidthOf(size);
    if (!width) return coverPath;
    try {
        return await coverFileForWidth(coverPath, relativePath, width);
    } catch (err) {
        logger.warn(`[ImageStorage] Could not scale ${relativePath}, serving it whole: ${err instanceof Error ? err.message : String(err)}`);
        return coverPath;
    }
}

/**
 * The file to serve for a stored cover at a width: a smaller copy, written beside it once, when the cover is wider;
 * the cover itself when it is no wider (a copy would only duplicate it) or a copy's path would leave the covers folder.
 * A copy older than its cover was made from earlier bytes and is made again.
 */
export async function coverFileForWidth(coverPath: string, relativePath: string, width: number): Promise<string> {
    const resizedPath = getResizedImagePath(`native:${relativePath}`, width);
    if (!resizedPath) return coverPath;
    const cover = await fs.promises.stat(coverPath);
    const copy = await fs.promises.stat(resizedPath).catch(() => null);
    if (copy && copy.mtimeMs >= cover.mtimeMs) return resizedPath;
    const original = await fs.promises.readFile(coverPath);
    const resized = await resizeImageBuffer(original, width);
    if (resized === original) return coverPath;
    // Written atomically, so a request arriving mid-write (or after a crash) never finds a half-written copy.
    await writeAtomically(resizedPath, resized);
    // A cover stored anew while its old bytes were being resized has had its copies cleared already: this one is stale.
    const now = await fs.promises.stat(coverPath).catch(() => null);
    if (!now || now.mtimeMs !== cover.mtimeMs || now.size !== cover.size) {
        await fs.promises.rm(resizedPath, { force: true });
        return coverPath;
    }
    return resizedPath;
}
