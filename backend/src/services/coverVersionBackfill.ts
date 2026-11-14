/**
 * The one-time pass that gives every stored cover value a version, so that afterwards no stored value is
 * unversioned and every address clients are sent can be kept for good. A value names its file (`native:albums/<id>.jpg`);
 * the pass reads the file once per value and stores `native:albums/<id>.jpg?v=<version>` in every column that held it:
 * album covers, a person's album cover, artist pictures. Audiobooks get the version of their cached cover on their own
 * `coverVersion` column. The scanner once stored album covers in the covers folder itself (`native:<id>.jpg`); those are
 * filed under `albums/` with the rest (the file moved, the value rewritten to match), unless a cover of that name already
 * stands there, and then the value keeps its place and is only versioned.
 *
 * A value whose file is missing, or leads out of the covers folder, is left as it is (an unversioned address keeps
 * working); it does not keep the marker from being set. A trouble with a value, or a stop (shutdown), keeps the marker
 * unset so the next start finishes. Values already versioned are never read again. A new install has no settings row yet
 * and no old values, so it skips the pass.
 *
 * `rewriteCoverValues` is the other writer of versions on stored values: the format repair uses it for a file it converts,
 * and for a JPEG whose stored version is not the file's (a conversion whose database write failed). `storedVersions` lists
 * the versions the stored values carry, so that repair reads only the files a version names.
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { getSystemSettings, saveSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { coversBasePath, dropResizedCopies, parseStoredCover, resolveInCoversDir, storedCoverValue, versionOfFile } from "./imageStorage";
import type { StopCheck } from "../utils/stopCheck";

export interface CoverVersionResult {
    /** Stored values (each distinct address once) that carry a version now. */
    versioned: number;
    /** Root-folder album covers filed under `albums/`. */
    moved: number;
    /** Values left unversioned because their file is missing or outside the covers folder. */
    missing: number;
    /** Audiobooks given the version of their cached cover. */
    audiobooks: number;
    /** Values or books that could not be written. */
    failed: number;
    /** The pass ended early because the server is shutting down. */
    stopped: boolean;
}

/** The columns that hold a stored cover's address. */
const ADDRESS_COLUMNS = [
    { model: "album", column: "coverUrl" },
    { model: "album", column: "userCoverUrl" },
    { model: "artist", column: "heroUrl" },
    { model: "artist", column: "userHeroUrl" },
] as const;

/**
 * Stores `version` on every value, in any column, that points at the file at `relativePath` (under the covers folder),
 * whether it carried a version or not. The value may also move to `newRelativePath` when the file did. Answers how many
 * values it wrote. With `onlyOtherVersions`, a value that has no version, or already has `version`, is left as it is.
 */
export async function rewriteCoverValues(
    relativePath: string,
    version: string,
    newRelativePath = relativePath,
    onlyOtherVersions = false,
): Promise<number> {
    const value = storedCoverValue(newRelativePath, version);
    const points = (v: string | null) => {
        const cover = parseStoredCover(v);
        if (cover?.relativePath !== relativePath) return false;
        return !onlyOtherVersions || (cover.version !== null && cover.version !== version);
    };
    // The database narrows by prefix (which can match a little more than the exact path); the exact test is here.
    const prefix = { startsWith: `native:${relativePath}` };
    let written = 0;

    const albums = await prisma.album.findMany({
        where: { OR: [{ coverUrl: prefix }, { userCoverUrl: prefix }] },
        select: { id: true, coverUrl: true, userCoverUrl: true },
    });
    for (const album of albums) {
        const data = {
            ...(points(album.coverUrl) && { coverUrl: value }),
            ...(points(album.userCoverUrl) && { userCoverUrl: value }),
        };
        const keys = Object.keys(data).length;
        if (keys > 0) {
            await prisma.album.update({ where: { id: album.id }, data });
            written += keys;
        }
    }
    const artists = await prisma.artist.findMany({
        where: { OR: [{ heroUrl: prefix }, { userHeroUrl: prefix }] },
        select: { id: true, heroUrl: true, userHeroUrl: true },
    });
    for (const artist of artists) {
        const data = {
            ...(points(artist.heroUrl) && { heroUrl: value }),
            ...(points(artist.userHeroUrl) && { userHeroUrl: value }),
        };
        const keys = Object.keys(data).length;
        if (keys > 0) {
            await prisma.artist.update({ where: { id: artist.id }, data });
            written += keys;
        }
    }
    return written;
}

/** The versions stored values carry, by the path under the covers folder they name (a value with no version adds none). */
export async function storedVersions(): Promise<Map<string, Set<string>>> {
    const found = new Map<string, Set<string>>();
    const add = (values: (string | null)[]) => {
        for (const value of values) {
            const cover = parseStoredCover(value);
            if (!cover?.version) continue;
            const known = found.get(cover.relativePath) ?? new Set<string>();
            known.add(cover.version);
            found.set(cover.relativePath, known);
        }
    };
    const where = (column: string) => ({ [column]: { startsWith: "native:", contains: "?v=" } });
    add((await prisma.album.findMany({ where: where("coverUrl"), distinct: ["coverUrl"], select: { coverUrl: true } })).map((r) => r.coverUrl));
    add((await prisma.album.findMany({ where: where("userCoverUrl"), distinct: ["userCoverUrl"], select: { userCoverUrl: true } })).map((r) => r.userCoverUrl));
    add((await prisma.artist.findMany({ where: where("heroUrl"), distinct: ["heroUrl"], select: { heroUrl: true } })).map((r) => r.heroUrl));
    add((await prisma.artist.findMany({ where: where("userHeroUrl"), distinct: ["userHeroUrl"], select: { userHeroUrl: true } })).map((r) => r.userHeroUrl));
    return found;
}

/** Every distinct stored address, in any column, that has no version yet. */
async function unversionedValues(): Promise<string[]> {
    // Unversioned, or a root-folder cover (no folder in its name) that is to be filed under albums/ whether versioned or not.
    const where = (column: string) => ({
        [column]: { startsWith: "native:" },
        OR: [{ NOT: { [column]: { contains: "?v=" } } }, { NOT: { [column]: { contains: "/" } } }],
    });
    const found = new Set<string>();
    const add = (values: (string | null)[]) => values.forEach((v) => v && found.add(v));
    add((await prisma.album.findMany({ where: where("coverUrl"), distinct: ["coverUrl"], select: { coverUrl: true } })).map((r) => r.coverUrl));
    add((await prisma.album.findMany({ where: where("userCoverUrl"), distinct: ["userCoverUrl"], select: { userCoverUrl: true } })).map((r) => r.userCoverUrl));
    add((await prisma.artist.findMany({ where: where("heroUrl"), distinct: ["heroUrl"], select: { heroUrl: true } })).map((r) => r.heroUrl));
    add((await prisma.artist.findMany({ where: where("userHeroUrl"), distinct: ["userHeroUrl"], select: { userHeroUrl: true } })).map((r) => r.userHeroUrl));
    return [...found];
}

/** Writes `to` wherever `from` stands exactly, in every column. Exact matches only: `from` has no version to match loosely. */
async function replaceValue(from: string, to: string): Promise<void> {
    for (const { model, column } of ADDRESS_COLUMNS) {
        if (model === "album") await prisma.album.updateMany({ where: { [column]: from }, data: { [column]: to } });
        else await prisma.artist.updateMany({ where: { [column]: from }, data: { [column]: to } });
    }
}

/**
 * Files a root-folder album cover (`<name>.jpg` in the covers folder itself) under `albums/`. Answers the path it is
 * under now: `albums/<name>.jpg` when moved, else where it was (a cover of that name already stands in `albums/`).
 */
async function fileUnderAlbums(relativePath: string, file: string): Promise<{ relativePath: string; moved: boolean }> {
    const target = path.join(coversBasePath(), "albums", relativePath);
    if (await fs.promises.access(target).then(() => true, () => false)) return { relativePath, moved: false };
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.rename(file, target);
    // Its smaller copies were made beside the old name; they are of no use there now.
    await dropResizedCopies(file);
    return { relativePath: `albums/${relativePath}`, moved: true };
}

/**
 * Runs the pass unless it has run. Answers null when it did not run (already done, or no settings row yet), else what it
 * did. One value's trouble is counted, not thrown; a failure of the marker save throws, and the caller logs it.
 */
export async function backfillCoverVersionsOnce({ shouldStop }: StopCheck): Promise<CoverVersionResult | null> {
    const settings = await getSystemSettings();
    // No settings row yet is a new install: it stores every cover with a version already.
    if (!settings || settings.coverVersionsAddedAt) return null;

    const result: CoverVersionResult = { versioned: 0, moved: 0, missing: 0, audiobooks: 0, failed: 0, stopped: false };

    for (const value of await unversionedValues()) {
        if (shouldStop?.()) {
            result.stopped = true;
            return result;
        }
        try {
            const cover = parseStoredCover(value);
            const file = cover && resolveInCoversDir(cover.relativePath);
            if (!cover || !file) {
                result.missing++;
                continue;
            }
            const version = await versionOfFile(file);
            if (!version) {
                result.missing++;
                continue;
            }
            let relativePath = cover.relativePath;
            // The scanner's old covers sat in the covers folder itself.
            if (!relativePath.includes("/") && relativePath.endsWith(".jpg")) {
                relativePath = (await fileUnderAlbums(relativePath, file)).relativePath;
            }
            try {
                await replaceValue(value, storedCoverValue(relativePath, version));
            } catch (err) {
                // The value still names the old place: the file goes back, so it points at a file.
                if (relativePath !== cover.relativePath) await fs.promises.rename(path.join(coversBasePath(), relativePath), file);
                throw err;
            }
            result.versioned++;
            if (relativePath !== cover.relativePath) result.moved++;
        } catch (err) {
            result.failed++;
            logger.warn(`[COVER-VERSIONS] Could not version ${value}: ${(err as Error).message}`);
        }
    }

    const books = await prisma.audiobook.findMany({
        where: { localCoverPath: { not: null }, coverVersion: null },
        select: { id: true, localCoverPath: true },
    });
    for (const book of books) {
        if (shouldStop?.()) {
            result.stopped = true;
            return result;
        }
        try {
            const version = book.localCoverPath ? await versionOfFile(book.localCoverPath) : null;
            if (!version) continue; // The cached file is gone; the next sync stores the cover again, with its version.
            await prisma.audiobook.update({ where: { id: book.id }, data: { coverVersion: version } });
            result.audiobooks++;
        } catch (err) {
            result.failed++;
            logger.warn(`[COVER-VERSIONS] Could not version the cover of audiobook ${book.id}: ${(err as Error).message}`);
        }
    }

    if (result.failed === 0) await saveSystemSettings({ coverVersionsAddedAt: new Date() });
    return result;
}
