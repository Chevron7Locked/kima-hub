import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";

interface ItunesPodcast {
    collectionId: number;
    collectionName: string;
    artistName: string;
    artworkUrl600?: string;
    artworkUrl100?: string;
    feedUrl: string;
    genres: string[];
    trackCount?: number;
    country?: string;
    primaryGenreName?: string;
    contentAdvisoryRating?: string;
    collectionViewUrl?: string;
}

class ItunesService {
    private client: AxiosInstance;
    private lastRequestTime = 0;
    private readonly RATE_LIMIT_MS = 3000; // 20 requests per minute = 3 seconds between requests

    constructor() {
        this.client = axios.create({
            baseURL: "https://itunes.apple.com",
            timeout: 10000,
        });
    }

    private async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.RATE_LIMIT_MS) {
            const delay = this.RATE_LIMIT_MS - timeSinceLastRequest;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        this.lastRequestTime = Date.now();
    }

    private async cachedRequest<T>(
        cacheKey: string,
        requestFn: () => Promise<T>,
        ttlSeconds = 604800 // 7 days default
    ): Promise<T> {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        await this.rateLimit();
        const data = await requestFn();

        try {
            await redisClient.setEx(cacheKey, ttlSeconds, JSON.stringify(data));
        } catch (err) {
            logger.warn("Redis set error:", err);
        }

        return data;
    }

    /**
     * Search for podcasts by term
     */
    async searchPodcasts(
        term: string,
        limit = 20
    ): Promise<ItunesPodcast[]> {
        const cacheKey = `itunes:search:${term}:${limit}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get("/search", {
                    params: {
                        term,
                        media: "podcast",
                        entity: "podcast",
                        limit,
                    },
                });

                return response.data.results || [];
            },
            2592000 // 30 days - podcast catalog changes slowly
        );
    }

    /**
     * Lookup podcast by iTunes ID
     */
    async getPodcastById(podcastId: number): Promise<ItunesPodcast | null> {
        const cacheKey = `itunes:podcast:${podcastId}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get("/lookup", {
                    params: {
                        id: podcastId,
                        entity: "podcast",
                    },
                });

                const results = response.data.results || [];
                return results.length > 0 ? results[0] : null;
            },
            2592000 // 30 days
        );
    }

    /**
     * Extract primary keywords from podcast title/description for "similar podcasts" search
     */
    extractSearchKeywords(
        title: string,
        description?: string,
        author?: string
    ): string[] {
        const commonWords = new Set([
            "the",
            "a",
            "an",
            "and",
            "or",
            "but",
            "in",
            "on",
            "at",
            "to",
            "for",
            "of",
            "with",
            "by",
            "from",
            "up",
            "about",
            "into",
            "through",
            "during",
            "before",
            "after",
            "above",
            "below",
            "between",
            "under",
            "again",
            "further",
            "then",
            "once",
            "here",
            "there",
            "when",
            "where",
            "why",
            "how",
            "all",
            "both",
            "each",
            "few",
            "more",
            "most",
            "other",
            "some",
            "such",
            "no",
            "nor",
            "not",
            "only",
            "own",
            "same",
            "so",
            "than",
            "too",
            "very",
            "can",
            "will",
            "just",
            "should",
            "now",
            "podcast",
            "show",
            "episode",
            "episodes",
        ]);

        // Combine title and description
        const text = [title, description || "", author || ""]
            .join(" ")
            .toLowerCase()
            .replace(/[^\w\s]/g, " "); // Remove punctuation

        // Extract words, filter common words, and count occurrences
        const words = text.split(/\s+/).filter((word) => {
            return (
                word.length > 3 &&
                !commonWords.has(word) &&
                !/^\d+$/.test(word) // Remove pure numbers
            );
        });

        // Count word frequency
        const wordCount = new Map<string, number>();
        words.forEach((word) => {
            wordCount.set(word, (wordCount.get(word) || 0) + 1);
        });

        // Sort by frequency and take top 5
        const topWords = Array.from(wordCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([word]) => word);

        return topWords;
    }

    /**
     * Get similar podcasts based on keywords extracted from title/description
     * This provides a "similar podcasts" feature similar to Last.fm for music
     */
    async getSimilarPodcasts(
        title: string,
        description?: string,
        author?: string,
        limit = 10
    ): Promise<ItunesPodcast[]> {
        const keywords = this.extractSearchKeywords(title, description, author);

        if (keywords.length === 0) {
            logger.debug(
                "No keywords extracted for similar podcast search, falling back to title"
            );
            return this.searchPodcasts(title, limit);
        }

        logger.debug(
            ` Searching for similar podcasts using keywords: ${keywords.join(", ")}`
        );

        // Search using the top keyword (most relevant)
        const searchTerm = keywords[0];
        const cacheKey = `itunes:similar:${searchTerm}:${limit}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const results = await this.searchPodcasts(searchTerm, limit * 2);

                // Filter out the original podcast (by title similarity)
                const titleLower = title.toLowerCase();
                const filtered = results.filter((podcast) => {
                    const podcastTitleLower = podcast.collectionName.toLowerCase();
                    // Exclude if titles are very similar (likely same podcast)
                    return !podcastTitleLower.includes(titleLower.slice(0, 20));
                });

                return filtered.slice(0, limit);
            },
            2592000 // 30 days
        );
    }

    /**
     * Get top podcasts by genre using iTunes RSS feeds
     * Note: iTunes Search API doesn't support genreId filtering, but RSS feeds do
     */
    async getTopPodcastsByGenre(
        genreId: number,
        limit = 20
    ): Promise<ItunesPodcast[]> {
        logger.debug(`[iTunes SERVICE] getTopPodcastsByGenre called with genre=${genreId}, limit=${limit}`);
        const cacheKey = `itunes:genre:${genreId}:${limit}`;
        logger.debug(`[iTunes SERVICE] Cache key: ${cacheKey}`);

        const result = await this.cachedRequest(
            cacheKey,
            async () => {
                try {
                    logger.debug(`[iTunes] Fetching genre ${genreId} from RSS feed...`);

                    // Use iTunes RSS feed for top podcasts by genre
                    const response = await this.client.get(
                        `/us/rss/toppodcasts/genre=${genreId}/limit=${limit}/json`
                    );

                logger.debug(`[iTunes] Response status: ${response.status}`);
                logger.debug(`[iTunes] Has feed data: ${!!response.data?.feed}`);
                logger.debug(`[iTunes] Entries count: ${response.data?.feed?.entry?.length || 0}`);

                const entries = response.data?.feed?.entry || [];

                // If only one entry, it might not be an array
                const entriesArray = Array.isArray(entries) ? entries : [entries];

                logger.debug(`[iTunes] Processing ${entriesArray.length} entries`);

                // Convert RSS feed format to our podcast format
                const podcasts = entriesArray.map((entry: any) => {
                    const podcast = {
                        collectionId: parseInt(entry.id?.attributes?.["im:id"] || "0", 10),
                        collectionName: entry["im:name"]?.label || entry.title?.label?.split(" - ")[0] || "Unknown",
                        artistName: entry["im:artist"]?.label || entry.title?.label?.split(" - ")[1] || "Unknown",
                        artworkUrl600: entry["im:image"]?.find((img: any) => img.attributes?.height === "170")?.label,
                        artworkUrl100: entry["im:image"]?.find((img: any) => img.attributes?.height === "60")?.label,
                        feedUrl: "", // RSS feed doesn't include feed URL
                        genres: entry.category ? [entry.category.attributes?.label] : [],
                        trackCount: 0,
                        primaryGenreName: entry.category?.attributes?.label,
                        collectionViewUrl: entry.link?.attributes?.href,
                    };
                    logger.debug(`[iTunes] Mapped podcast: ${podcast.collectionName} (ID: ${podcast.collectionId})`);
                    return podcast;
                }).filter((p: any) => p.collectionId > 0); // Filter out invalid entries

                    logger.debug(`[iTunes] Returning ${podcasts.length} valid podcasts`);
                    return podcasts;
                } catch (error) {
                    logger.error(`[iTunes] ERROR in requestFn:`, error);
                    return [];
                }
            },
            2592000 // 30 days
        );

        logger.debug(`[iTunes SERVICE] cachedRequest returned ${result.length} podcasts`);
        return result;
    }
}



export const itunesService = new ItunesService();
