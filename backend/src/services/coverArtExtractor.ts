import * as fs from "fs";
import { logger } from "../utils/logger";
import * as path from "path";
import * as crypto from "crypto";
import { parseFile } from "music-metadata";

export class CoverArtExtractor {
    private coverCachePath: string;

    constructor(coverCachePath: string) {
        this.coverCachePath = coverCachePath;

        // Ensure cache directory exists
        if (!fs.existsSync(this.coverCachePath)) {
            fs.mkdirSync(this.coverCachePath, { recursive: true });
        }
    }

    /**
     * Extract cover art from audio file and save to cache
     * Returns relative path to cached cover art, or null if none found
     */
    async extractCoverArt(
        audioFilePath: string,
        albumId: string
    ): Promise<string | null> {
        try {
            // Check if already cached
            const cacheFileName = `${albumId}.jpg`;
            const cachePath = path.join(this.coverCachePath, cacheFileName);

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

            // Save to cache
            await fs.promises.writeFile(cachePath, picture.data);

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

    /**
     * Get cover art URL for album
     * Returns relative path if available, or null
     */
    async getCoverArtPath(albumId: string): Promise<string | null> {
        const cacheFileName = `${albumId}.jpg`;
        const cachePath = path.join(this.coverCachePath, cacheFileName);

        if (fs.existsSync(cachePath)) {
            return cacheFileName;
        }

        return null;
    }
}
