/**
 * Image Provider Service
 *
 * Tries multiple sources for high-quality artist/album artwork:
 * 1. Deezer (most reliable, high quality)
 * 2. Fanart.tv (excellent quality, requires API key)
 * 3. MusicBrainz Cover Art Archive (good quality)
 * 4. Last.fm (fallback, often missing)
 */

import { logger } from "../utils/logger";
import axios from "axios";

export interface ImageSearchOptions {
    preferredSize?: "small" | "medium" | "large" | "extralarge" | "mega";
    timeout?: number;
}

export interface ImageResult {
    url: string;
    source: "deezer" | "fanart" | "musicbrainz" | "lastfm" | "spotify";
    size?: string;
}

export class ImageProviderService {
    private readonly FANART_API_KEY = process.env.FANART_API_KEY;
    private readonly DEEZER_API_URL = "https://api.deezer.com";
    private readonly FANART_API_URL = "https://webservice.fanart.tv/v3";

    /**
     * Get artist image from multiple sources with fallback chain
     */
    async getArtistImage(
        artistName: string,
        mbid?: string,
        options: ImageSearchOptions = {}
    ): Promise<ImageResult | null> {
        const { timeout = 5000 } = options;

        logger.debug(`[IMAGE] Searching for artist image: ${artistName}`);

        // Try Deezer first (most reliable)
        try {
            const deezerImage = await this.getArtistImageFromDeezer(
                artistName,
                timeout
            );
            if (deezerImage) {
                logger.debug(`  Found image from Deezer`);
                return deezerImage;
            }
        } catch (error) {
            logger.debug(
                `    Deezer failed: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }

        // Try Fanart.tv if we have API key and MBID
        if (this.FANART_API_KEY && mbid) {
            try {
                const fanartImage = await this.getArtistImageFromFanart(
                    mbid,
                    timeout
                );
                if (fanartImage) {
                    logger.debug(`  Found image from Fanart.tv`);
                    return fanartImage;
                }
            } catch (error) {
                logger.debug(
                    `Fanart.tv failed: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
            }
        }

        // Try MusicBrainz/Cover Art Archive if we have MBID
        if (mbid) {
            try {
                const mbImage = await this.getArtistImageFromMusicBrainz(
                    mbid,
                    timeout
                );
                if (mbImage) {
                    logger.debug(`  Found image from MusicBrainz`);
                    return mbImage;
                }
            } catch (error) {
                logger.debug(
                    `MusicBrainz failed: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
            }
        }

        logger.debug(` No artist image found from any source`);
        return null;
    }

    /**
     * Get album cover from multiple sources with fallback chain
     */
    async getAlbumCover(
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
        options: ImageSearchOptions = {}
    ): Promise<ImageResult | null> {
        const { timeout = 5000 } = options;

        logger.debug(
            `[IMAGE] Searching for album cover: ${artistName} - ${albumTitle}`
        );

        // Try Deezer first (most reliable)
        try {
            const deezerCover = await this.getAlbumCoverFromDeezer(
                artistName,
                albumTitle,
                timeout
            );
            if (deezerCover) {
                logger.debug(`  Found cover from Deezer`);
                return deezerCover;
            }
        } catch (error) {
            logger.debug(
                `    Deezer failed: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }

        // Try MusicBrainz Cover Art Archive if we have MBID
        if (rgMbid) {
            try {
                const mbCover = await this.getAlbumCoverFromMusicBrainz(
                    rgMbid,
                    timeout
                );
                if (mbCover) {
                    logger.debug(`  Found cover from MusicBrainz`);
                    return mbCover;
                }
            } catch (error) {
                logger.debug(
                    `MusicBrainz failed: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
            }
        }

        // Try Fanart.tv if we have API key and MBID
        if (this.FANART_API_KEY && rgMbid) {
            try {
                const fanartCover = await this.getAlbumCoverFromFanart(
                    rgMbid,
                    timeout
                );
                if (fanartCover) {
                    logger.debug(`  Found cover from Fanart.tv`);
                    return fanartCover;
                }
            } catch (error) {
                logger.debug(
                    `Fanart.tv failed: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
            }
        }

        logger.debug(` No album cover found from any source`);
        return null;
    }

    /**
     * Search Deezer for artist image
     */
    private async getArtistImageFromDeezer(
        artistName: string,
        timeout: number
    ): Promise<ImageResult | null> {
        const response = await axios.get(
            `${this.DEEZER_API_URL}/search/artist`,
            {
                params: { q: artistName, limit: 1 },
                timeout,
            }
        );

        if (response.data.data && response.data.data.length > 0) {
            const artist = response.data.data[0];
            // Deezer provides: picture, picture_small, picture_medium, picture_big, picture_xl
            const imageUrl =
                artist.picture_xl || artist.picture_big || artist.picture;
            if (imageUrl) {
                return {
                    url: imageUrl,
                    source: "deezer",
                    size: "xl",
                };
            }
        }

        return null;
    }

    /**
     * Search Deezer for album cover
     */
    private async getAlbumCoverFromDeezer(
        artistName: string,
        albumTitle: string,
        timeout: number
    ): Promise<ImageResult | null> {
        const response = await axios.get(
            `${this.DEEZER_API_URL}/search/album`,
            {
                params: {
                    q: `artist:"${artistName}" album:"${albumTitle}"`,
                    limit: 5,
                },
                timeout,
            }
        );

        if (response.data.data && response.data.data.length > 0) {
            // Try to find exact match first
            let album = response.data.data.find(
                (a: any) =>
                    a.title.toLowerCase() === albumTitle.toLowerCase() &&
                    a.artist.name.toLowerCase() === artistName.toLowerCase()
            );

            // Fall back to first result
            if (!album) {
                album = response.data.data[0];
            }

            // Deezer provides: cover, cover_small, cover_medium, cover_big, cover_xl
            const coverUrl = album.cover_xl || album.cover_big || album.cover;
            if (coverUrl) {
                return {
                    url: coverUrl,
                    source: "deezer",
                    size: "xl",
                };
            }
        }

        return null;
    }

    /**
     * Get artist image from Fanart.tv
     */
    private async getArtistImageFromFanart(
        mbid: string,
        timeout: number
    ): Promise<ImageResult | null> {
        if (!this.FANART_API_KEY) {
            return null;
        }

        const response = await axios.get(
            `${this.FANART_API_URL}/music/${mbid}`,
            {
                params: { api_key: this.FANART_API_KEY },
                timeout,
            }
        );

        // Fanart.tv provides multiple image types, prefer artistthumb
        const images =
            response.data.artistthumb ||
            response.data.musicbanner ||
            response.data.hdmusiclogo;
        if (images && images.length > 0) {
            return {
                url: images[0].url,
                source: "fanart",
            };
        }

        return null;
    }

    /**
     * Get album cover from Fanart.tv
     */
    private async getAlbumCoverFromFanart(
        rgMbid: string,
        timeout: number
    ): Promise<ImageResult | null> {
        if (!this.FANART_API_KEY) {
            return null;
        }

        const response = await axios.get(
            `${this.FANART_API_URL}/music/albums/${rgMbid}`,
            {
                params: { api_key: this.FANART_API_KEY },
                timeout,
            }
        );

        // Prefer albumcover, fall back to cdart
        const covers =
            response.data.albums?.[rgMbid]?.albumcover ||
            response.data.albums?.[rgMbid]?.cdart;

        if (covers && covers.length > 0) {
            return {
                url: covers[0].url,
                source: "fanart",
            };
        }

        return null;
    }

    /**
     * Get artist image from MusicBrainz (via relationships)
     */
    private async getArtistImageFromMusicBrainz(
        mbid: string,
        timeout: number
    ): Promise<ImageResult | null> {
        // MusicBrainz doesn't have direct artist images, but we can check for image relationships
        // This is a placeholder - in practice, we'd need to parse relationships
        return null;
    }

    /**
     * Get album cover from MusicBrainz Cover Art Archive
     */
    private async getAlbumCoverFromMusicBrainz(
        rgMbid: string,
        timeout: number
    ): Promise<ImageResult | null> {
        try {
            const response = await axios.get(
                `https://coverartarchive.org/release-group/${rgMbid}`,
                {
                    timeout,
                    validateStatus: (status) => status === 200,
                }
            );

            if (response.data.images && response.data.images.length > 0) {
                // Find front cover
                const frontCover =
                    response.data.images.find(
                        (img: any) => img.front === true
                    ) || response.data.images[0];

                return {
                    url: frontCover.image,
                    source: "musicbrainz",
                };
            }
        } catch (error) {
            // 404 is expected if no cover art exists
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                return null;
            }
            throw error;
        }

        return null;
    }

    /**
     * Get artist image from Last.fm (fallback only - often unreliable)
     */
    async getArtistImageFromLastFm(
        artistName: string,
        mbid?: string
    ): Promise<ImageResult | null> {
        try {
            const { lastFmService } = await import("./lastfm");
            const artistInfo = await lastFmService.getArtistInfo(
                artistName,
                mbid
            );

            if (artistInfo?.image) {
                const megaImage = artistInfo.image.find(
                    (img: any) => img.size === "mega"
                );
                const largeImage = artistInfo.image.find(
                    (img: any) => img.size === "extralarge"
                );
                const image = megaImage || largeImage;

                if (image?.["#text"]) {
                    return {
                        url: image["#text"],
                        source: "lastfm",
                        size: image.size,
                    };
                }
            }
        } catch (error) {
            logger.debug(
                `Last.fm failed: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }

        return null;
    }
}

export const imageProviderService = new ImageProviderService();
