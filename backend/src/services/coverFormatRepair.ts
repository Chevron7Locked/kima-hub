/**
 * The one-time repair of stored covers saved before every stored picture was written as a JPEG: a `.jpg` can hold PNG or
 * WebP bytes, and is then served as `image/jpeg`; and a local artist picture can sit as `<id>.png` or `<id>.webp`, with
 * the artist's pictures pointing at that name (with or without a version). The pass converts the old-named artist
 * pictures first (each to `<id>.jpg` through `storeAsJpeg`, the artist rows moved over to it, then the old file removed),
 * then walks every covers folder once and converts the `.jpg` files in place through `replaceWithJpeg` (atomic, so a
 * reader never meets half a file; and dropped when the file was written anew since it was read, so the older bytes never
 * overwrite a newer write), gives every stored value that names a converted file a new version (the address clients keep
 * for good must change with the picture), and records the done marker. A file that is a JPEG already gets the same for
 * any stored version that is not its own: a conversion whose database write failed left a JPEG under the old version, and
 * a version always names the bytes served. Only the files a stored version names are read for this.
 *
 * A file that is no picture is left alone and logged: it is not this pass's to delete. A file that could not be written
 * keeps the marker unset, so the next start tries again. A stop (shutdown) ends the pass between files and also keeps
 * the marker unset. A new install has no settings row yet and no old covers, so it skips the pass.
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { getSystemSettings, saveSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { audiobookCoversPath, coverAddressWhere, coversBasePath, MAX_PICTURE_BYTES, replaceWithJpeg, storeAsJpeg, versionOfFile } from "./imageStorage";
import { rewriteCoverValues, storedVersions } from "./coverVersionBackfill";
import type { StopCheck } from "../utils/stopCheck";
import { flushShownChanges } from "./shownChanges";

export interface CoverRepairResult {
    /** Files that held another format and are JPEGs now. */
    converted: number;
    /** Artist pictures saved as `.png` or `.webp` that are `<id>.jpg` now, their artists moved over to it. */
    artistPicturesConverted: number;
    /** JPEGs whose stored version was not the file's: the stored values were re-versioned. */
    reversioned: number;
    /** Files written anew after the pass read them: the newer write stands (it is a JPEG already). */
    superseded: number;
    /** Files that are no picture (a `.jpg`, or an old `.png` or `.webp` artist picture), left as they were. */
    notPictures: number;
    /** Files that could not be read or written. */
    failed: number;
    /** The pass ended early because the server is shutting down. */
    stopped: boolean;
}

/** Every place a `.jpg` cover is stored: the covers folder itself (the scanner's embedded art), its artists and albums folders, and the audiobook cover cache. */
function coverFolders(): string[] {
    const covers = coversBasePath();
    return [covers, path.join(covers, "artists"), path.join(covers, "albums"), audiobookCoversPath()];
}

/** The path of a file under the covers folder, as stored values spell it (forward slashes). */
function relativeToCovers(file: string): string {
    return path.relative(coversBasePath(), file).split(path.sep).join("/");
}

/** Whether the file starts with the JPEG signature. */
async function isJpeg(file: string): Promise<boolean> {
    const handle = await fs.promises.open(file, "r");
    try {
        const head = Buffer.alloc(3);
        const { bytesRead } = await handle.read(head, 0, 3, 0);
        return bytesRead === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    } finally {
        await handle.close();
    }
}

/** The old-named artist pictures: `<id>.png` and `<id>.webp` in the artists folder. */
const OLD_ARTIST_PICTURE = /^(.+)\.(png|webp)$/;

/**
 * Converts one old-named artist picture to `<id>.jpg` and moves the artists pointing at it. A picture no artist points at
 * is removed when the `.jpg` stands in its place, and left otherwise. One over the size cap, a symbolic link, or no
 * picture is left, with its artists. `result` takes the counts.
 */
async function convertOldArtistPicture(dir: string, name: string, id: string, result: CoverRepairResult): Promise<void> {
    const file = path.join(dir, name);
    const jpeg = path.join(dir, `${id}.jpg`);
    const was = `artists/${name}`;
    // lstat, not stat: a symbolic link is not ours to read through or remove.
    const onDisk = await fs.promises.lstat(file);
    if (!onDisk.isFile()) return;

    // Any version: the version backfill may have stamped the old name before this pass finished.
    const pointing = { OR: [coverAddressWhere("heroUrl", was), coverAddressWhere("userHeroUrl", was)] };
    if ((await prisma.artist.count({ where: pointing })) === 0) {
        if (await fs.promises.access(jpeg).then(() => true, () => false)) await fs.promises.rm(file, { force: true });
        return;
    }
    if (onDisk.size > MAX_PICTURE_BYTES) {
        logger.warn(`[COVER-REPAIR] ${file} is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB; left as it is`);
        return;
    }
    const version = await storeAsJpeg(jpeg, await fs.promises.readFile(file));
    if (!version) {
        result.notPictures++;
        logger.warn(`[COVER-REPAIR] ${file} is no picture; left as it is`);
        return;
    }
    await rewriteCoverValues(was, version, { newRelativePath: `artists/${id}.jpg` });
    await fs.promises.rm(file, { force: true });
    result.artistPicturesConverted++;
    logger.debug(`[COVER-REPAIR] Converted ${file} to ${jpeg}`);
}

/**
 * The bytes of `file` changed, so the version of every value that names it does too: an address clients kept for good
 * must not keep showing the old picture. A file whose version cannot be read leaves its values as they were.
 */
async function versionConvertedCover(dir: string, file: string): Promise<void> {
    const version = await versionOfFile(file);
    // A JPEG whose values keep the old version would be served as the new bytes under an address kept for good: a failure, so the marker stays unset.
    if (!version) throw new Error("the converted file cannot be read for its version");
    if (dir === audiobookCoversPath()) {
        await prisma.audiobook.updateMany({ where: { localCoverPath: file }, data: { coverVersion: version } });
        return;
    }
    await rewriteCoverValues(relativeToCovers(file), version);
}

/** The versions stored on values and on audiobooks, read once for the pass. */
interface StoredVersionIndex {
    covers: Map<string, Set<string>>;
    audiobooks: Map<string, string>;
}

async function readStoredVersions(): Promise<StoredVersionIndex> {
    const books = await prisma.audiobook.findMany({
        where: { localCoverPath: { not: null }, coverVersion: { not: null } },
        select: { localCoverPath: true, coverVersion: true },
    });
    const audiobooks = new Map<string, string>();
    for (const book of books) if (book.localCoverPath && book.coverVersion) audiobooks.set(book.localCoverPath, book.coverVersion);
    return { covers: await storedVersions(), audiobooks };
}

/**
 * A JPEG needs no conversion, but a stored version that names other bytes is wrong (a conversion whose database write
 * failed left one). Answers whether it re-versioned anything.
 */
async function reversionStaleCover(dir: string, file: string, index: StoredVersionIndex): Promise<boolean> {
    const relativePath = relativeToCovers(file);
    if (dir === audiobookCoversPath()) {
        const stored = index.audiobooks.get(file);
        if (!stored) return false;
        const version = await versionOfFile(file);
        if (!version || version === stored) return false;
        await prisma.audiobook.updateMany({ where: { localCoverPath: file, coverVersion: { not: null } }, data: { coverVersion: version } });
        return true;
    }
    const stored = index.covers.get(relativePath);
    if (!stored) return false;
    const version = await versionOfFile(file);
    if (!version || (stored.size === 1 && stored.has(version))) return false;
    await rewriteCoverValues(relativePath, version, { onlyOtherVersions: true });
    return true;
}

/**
 * Runs the pass unless it has run. Answers null when it did not run (already done, or no settings row yet), else what it
 * did. One file's trouble is counted, not thrown; a failure of the marker save throws, and the caller logs it.
 */
export async function repairCoverFormatsOnce(stop: StopCheck): Promise<CoverRepairResult | null> {
    try {
        return await repairCoverFormats(stop);
    } finally {
        // The new versions and addresses it stored change what clients are handed: one change of the library for the pass.
        await flushShownChanges();
    }
}

async function repairCoverFormats({ shouldStop }: StopCheck): Promise<CoverRepairResult | null> {
    const settings = await getSystemSettings();
    // No settings row yet is a new install: it has stored no covers in the old way.
    if (!settings || settings.coverFormatsRepairedAt) return null;

    const result: CoverRepairResult = {
        converted: 0,
        artistPicturesConverted: 0,
        reversioned: 0,
        superseded: 0,
        notPictures: 0,
        failed: 0,
        stopped: false,
    };

    // First, so the `.jpg` walk below meets the converted pictures as the JPEGs they are.
    const artistsDir = path.join(coversBasePath(), "artists");
    for (const name of await fs.promises.readdir(artistsDir).catch(() => [] as string[])) {
        const old = OLD_ARTIST_PICTURE.exec(name);
        if (!old) continue;
        if (shouldStop?.()) {
            result.stopped = true;
            return result;
        }
        try {
            await convertOldArtistPicture(artistsDir, name, old[1], result);
        } catch (err) {
            result.failed++;
            logger.warn(`[COVER-REPAIR] Could not repair ${path.join(artistsDir, name)}: ${(err as Error).message}`);
        }
    }

    let index: StoredVersionIndex | null = null;
    for (const dir of coverFolders()) {
        let names: string[];
        try {
            names = await fs.promises.readdir(dir);
        } catch {
            continue; // The folder was never used.
        }
        for (const name of names) {
            if (!name.endsWith(".jpg")) continue;
            if (shouldStop?.()) {
                result.stopped = true;
                return result;
            }
            const file = path.join(dir, name);
            try {
                // lstat, not stat: a symbolic link is not ours to replace with a real file.
                const read = await fs.promises.lstat(file);
                if (!read.isFile()) continue;
                if (await isJpeg(file)) {
                    index ??= await readStoredVersions();
                    if (await reversionStaleCover(dir, file, index)) {
                        result.reversioned++;
                        logger.debug(`[COVER-REPAIR] ${file} had a stored version that was not its own; re-versioned`);
                    }
                    continue;
                }
                const bytes = await fs.promises.readFile(file);
                const outcome = await replaceWithJpeg(file, bytes, { mtimeMs: read.mtimeMs, size: read.size });
                if (outcome === "replaced") {
                    result.converted++;
                    await versionConvertedCover(dir, file);
                    logger.debug(`[COVER-REPAIR] Converted ${file} to a JPEG`);
                } else if (outcome === "changed") {
                    result.superseded++;
                    logger.debug(`[COVER-REPAIR] ${file} was written anew meanwhile; the newer write stands`);
                } else {
                    result.notPictures++;
                    logger.warn(`[COVER-REPAIR] ${file} is no picture; left as it is`);
                }
            } catch (err) {
                result.failed++;
                logger.warn(`[COVER-REPAIR] Could not repair ${file}: ${(err as Error).message}`);
            }
        }
    }

    if (result.failed === 0) await saveSystemSettings({ coverFormatsRepairedAt: new Date() });
    return result;
}
