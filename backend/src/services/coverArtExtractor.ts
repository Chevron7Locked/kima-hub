import * as fs from "fs";
import { logger } from "../utils/logger";
import * as path from "path";
import { parseFile } from "music-metadata";
import { MAX_PICTURE_BYTES, storeAsJpeg } from "./imageStorage";

/** Where an album's cover is stored under the covers folder, as every album cover is: `albums/<id>.jpg`. */
const ALBUMS_FOLDER = "albums";

export class CoverArtExtractor {
    private coverCachePath: string;

    constructor(coverCachePath: string) {
        this.coverCachePath = coverCachePath;

        // Ensure the folder album covers are stored in exists
        fs.mkdirSync(path.join(this.coverCachePath, ALBUMS_FOLDER), { recursive: true });
    }

    /**
     * Extract cover art from audio file and save to cache
     * Returns the path of the cached cover art under the covers folder (`albums/<id>.jpg`), or null if none found
     */
    async extractCoverArt(
        audioFilePath: string,
        albumId: string
    ): Promise<string | null> {
        try {
            // Check if already cached
            const cacheFileName = `${ALBUMS_FOLDER}/${albumId}.jpg`;
            const cachePath = path.join(this.coverCachePath, ALBUMS_FOLDER, `${albumId}.jpg`);

            if (fs.existsSync(cachePath)) {
                return cacheFileName;
            }

            // Parse audio file metadata
            const metadata = await parseFile(audioFilePath);

            // Get embedded picture
            const picture = metadata.common.picture?.[0];
            if (!picture) {
                return null;
            }

            // music-metadata has no read limit, so the picture is already in memory here; the cap stops it being decoded and stored.
            if (picture.data.byteLength > MAX_PICTURE_BYTES) {
                logger.warn(`[COVER-ART] Embedded picture in ${path.basename(audioFilePath)} is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB; skipped`);
                return null;
            }

            // Save to cache, as a JPEG whatever format the file embeds
            if (!(await storeAsJpeg(cachePath, Buffer.from(picture.data)))) {
                logger.debug(`[COVER-ART] Embedded picture in ${path.basename(audioFilePath)} is not readable`);
                return null;
            }

            logger.debug(
                `[COVER-ART] Extracted cover art from ${path.basename(audioFilePath)}: ${cacheFileName}`
            );

            return cacheFileName;
        } catch (err) {
            logger.error(
                `[COVER-ART] Failed to extract from ${audioFilePath}:`,
                err
            );
            return null;
        }
    }
}
