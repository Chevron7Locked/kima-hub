import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";

interface WikidataResult {
    summary?: string;
    heroUrl?: string;
}

class WikidataService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            timeout: 10000,
            headers: {
                "User-Agent":
                    "Lidify/1.0.0 (https://github.com/Chevron7Locked/lidify)",
            },
        });
    }

    async getArtistInfo(
        artistName: string,
        mbid: string
    ): Promise<WikidataResult> {
        const cacheKey = `wikidata:${mbid}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            // Step 1: Query Wikidata for the MusicBrainz ID
            const wikidataId = await this.getWikidataIdFromMBID(mbid);

            if (!wikidataId) {
                logger.debug(`No Wikidata entry found for ${artistName}`);
                return {};
            }

            // Step 2: Get Wikipedia article and image
            const [summary, heroUrl] = await Promise.all([
                this.getWikipediaSummary(wikidataId),
                this.getWikidataImage(wikidataId),
            ]);

            const result: WikidataResult = { summary, heroUrl };

            // Cache for 30 days
            try {
                await redisClient.setEx(
                    cacheKey,
                    2592000,
                    JSON.stringify(result)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return result;
        } catch (error) {
            logger.error(`Wikidata fetch failed for ${artistName}:`, error);
            return {};
        }
    }

    private async getWikidataIdFromMBID(mbid: string): Promise<string | null> {
        const sparqlQuery = `
      SELECT ?item WHERE {
        ?item wdt:P434 "${mbid}" .
      }
      LIMIT 1
    `;

        const response = await this.client.get("https://query.wikidata.org/sparql", {
            params: {
                query: sparqlQuery,
                format: "json",
            },
        });

        const bindings = response.data.results?.bindings || [];
        if (bindings.length === 0) return null;

        const itemUrl = bindings[0].item.value;
        return itemUrl.split("/").pop() || null;
    }

    private async getWikipediaSummary(
        wikidataId: string
    ): Promise<string | undefined> {
        try {
            // Get English Wikipedia article title
            const response = await this.client.get(
                `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`
            );

            const entity = response.data.entities?.[wikidataId];
            const enWikiTitle = entity?.sitelinks?.enwiki?.title;

            if (!enWikiTitle) return undefined;

            // Get article summary from Wikipedia API
            const summaryResponse = await this.client.get(
                "https://en.wikipedia.org/api/rest_v1/page/summary/" +
                    encodeURIComponent(enWikiTitle)
            );

            return summaryResponse.data.extract;
        } catch (error) {
            logger.error(
                `Failed to get Wikipedia summary for ${wikidataId}:`,
                error
            );
            return undefined;
        }
    }

    private async getWikidataImage(
        wikidataId: string
    ): Promise<string | undefined> {
        try {
            const response = await this.client.get(
                `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`
            );

            const entity = response.data.entities?.[wikidataId];
            const imageProperty = entity?.claims?.P18; // P18 is "image"

            if (!imageProperty || imageProperty.length === 0) return undefined;

            const imageName = imageProperty[0].mainsnak?.datavalue?.value;
            if (!imageName) return undefined;

            // Convert to Wikimedia Commons URL
            const fileName = imageName.replace(/ /g, "_");
            const md5 = require("crypto")
                .createHash("md5")
                .update(fileName)
                .digest("hex");
            const url = `https://upload.wikimedia.org/wikipedia/commons/${
                md5[0]
            }/${md5[0]}${md5[1]}/${encodeURIComponent(fileName)}`;

            return url;
        } catch (error) {
            logger.error(
                `Failed to get Wikidata image for ${wikidataId}:`,
                error
            );
            return undefined;
        }
    }
}

export const wikidataService = new WikidataService();
