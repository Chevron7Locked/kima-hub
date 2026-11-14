/**
 * The one-time repair of stored covers saved before every stored picture was written as a JPEG (ticket 104): a `.jpg`
 * could hold PNG or WebP bytes, and was served as `image/jpeg`. The pass walks every covers folder once, converts those
 * files in place through `replaceWithJpeg` (atomic, so a reader never meets half a file; and dropped when the file was
 * written anew since it was read, so the older bytes never overwrite a newer write), and records the done marker.
 *
 * A file that is no picture is left alone and logged: it is not this pass's to delete. A file that could not be written
 * keeps the marker unset, so the next start tries again. A stop (shutdown) ends the pass between files and also keeps
 * the marker unset. A new install has no settings row yet and no old covers, so it skips the pass.
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { getSystemSettings, saveSystemSettings } from "../utils/systemSettings";
import { audiobookCoversPath, coversBasePath, replaceWithJpeg } from "./imageStorage";
import type { StopCheck } from "../utils/stopCheck";

export interface CoverRepairResult {
    /** Files that held another format and are JPEGs now. */
    converted: number;
    /** Files written anew after the pass read them: the newer write stands (it is a JPEG already). */
    superseded: number;
    /** Files named `.jpg` that are no picture, left as they were. */
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

/**
 * Runs the pass unless it has run. Answers null when it did not run (already done, or no settings row yet), else what it
 * did. One file's trouble is counted, not thrown; a failure of the marker save throws, and the caller logs it.
 */
export async function repairCoverFormatsOnce({ shouldStop }: StopCheck): Promise<CoverRepairResult | null> {
    const settings = await getSystemSettings();
    // No settings row yet is a new install: it has stored no covers in the old way.
    if (!settings || settings.coverFormatsRepairedAt) return null;

    const result: CoverRepairResult = { converted: 0, superseded: 0, notPictures: 0, failed: 0, stopped: false };

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
                if (!read.isFile() || (await isJpeg(file))) continue;
                const bytes = await fs.promises.readFile(file);
                const outcome = await replaceWithJpeg(file, bytes, { mtimeMs: read.mtimeMs, size: read.size });
                if (outcome === "replaced") {
                    result.converted++;
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
