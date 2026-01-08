import Parser from "rss-parser";
import { logger } from "../utils/logger";

interface RSSPodcast {
    title: string;
    author?: string;
    description?: string;
    imageUrl?: string;
    language?: string;
    explicit?: boolean;
    itunesId?: string;
}

interface RSSEpisode {
    guid: string;
    title: string;
    description?: string;
    audioUrl: string;
    duration: number; // seconds
    publishedAt: Date;
    episodeNumber?: number;
    season?: number;
    imageUrl?: string;
    fileSize?: number; // bytes
    mimeType?: string;
}

interface ParsedPodcastFeed {
    podcast: RSSPodcast;
    episodes: RSSEpisode[];
}

class RSSParserService {
    private parser: Parser;

    constructor() {
        this.parser = new Parser({
            customFields: {
                feed: [
                    ["itunes:author", "itunesAuthor"] as any,
                    ["itunes:image", "itunesImage"] as any,
                    ["itunes:explicit", "itunesExplicit"] as any,
                    ["itunes:type", "itunesType"] as any,
                ],
                item: [
                    ["itunes:author", "itunesAuthor"] as any,
                    ["itunes:duration", "itunesDuration"] as any,
                    ["itunes:image", "itunesImage"] as any,
                    ["itunes:episode", "itunesEpisode"] as any,
                    ["itunes:season", "itunesSeason"] as any,
                    ["itunes:explicit", "itunesExplicit"] as any,
                ],
            },
        });
    }

    /**
     * Parse an RSS podcast feed from a URL
     */
    async parseFeed(feedUrl: string): Promise<ParsedPodcastFeed> {
        try {
            logger.debug(`\n [RSS PARSER] Fetching feed: ${feedUrl}`);
            const feed = await this.parser.parseURL(feedUrl);

            // Extract podcast metadata
            const podcast: RSSPodcast = {
                title: feed.title || "Unknown Podcast",
                author: (feed as any).itunesAuthor || feed.author || undefined,
                description: feed.description || undefined,
                imageUrl: this.extractImageUrl(feed),
                language: feed.language || undefined,
                explicit: this.parseExplicit((feed as any).itunesExplicit),
                itunesId: this.extractItunesId(feed),
            };

            logger.debug(`   Podcast: ${podcast.title}`);
            logger.debug(`   Author: ${podcast.author || "Unknown"}`);
            logger.debug(`   Episodes found: ${feed.items?.length || 0}`);

            // Extract episodes
            const episodes: RSSEpisode[] = (feed.items || [])
                .map((item) => {
                    try {
                        // Find audio enclosure
                        const audioEnclosure = this.findAudioEnclosure(item);
                        if (!audioEnclosure) {
                            logger.warn(
                                ` Skipping episode "${item.title}" - no audio found`
                            );
                            return null;
                        }

                        const episode: RSSEpisode = {
                            guid: item.guid || item.link || item.title || "",
                            title: item.title || "Unknown Episode",
                            description:
                                item.content ||
                                item.contentSnippet ||
                                undefined,
                            audioUrl: audioEnclosure.url,
                            duration: this.parseDuration(
                                (item as any).itunesDuration
                            ),
                            publishedAt: item.pubDate
                                ? new Date(item.pubDate)
                                : new Date(),
                            episodeNumber: (item as any).itunesEpisode
                                ? parseInt((item as any).itunesEpisode)
                                : undefined,
                            season: (item as any).itunesSeason
                                ? parseInt((item as any).itunesSeason)
                                : undefined,
                            imageUrl:
                                this.extractImageUrl(item) ||
                                podcast.imageUrl ||
                                undefined,
                            fileSize: audioEnclosure.length
                                ? parseInt(audioEnclosure.length)
                                : undefined,
                            mimeType: audioEnclosure.type || "audio/mpeg",
                        };

                        return episode;
                    } catch (error: any) {
                        logger.error(
                            `    Error parsing episode "${item.title}":`,
                            error.message
                        );
                        return null;
                    }
                })
                .filter((ep): ep is RSSEpisode => ep !== null);

            logger.debug(`   Successfully parsed ${episodes.length} episodes`);

            return { podcast, episodes };
        } catch (error: any) {
            logger.error(
                `\n [RSS PARSER] Failed to parse feed:`,
                error.message
            );
            throw new Error(`Failed to parse podcast feed: ${error.message}`);
        }
    }

    /**
     * Extract image URL from feed/item
     */
    private extractImageUrl(data: any): string | undefined {
        // Try iTunes image first
        if (data.itunesImage) {
            if (typeof data.itunesImage === "string") {
                return data.itunesImage;
            }
            if (data.itunesImage.href) {
                return data.itunesImage.href;
            }
            if (data.itunesImage.$ && data.itunesImage.$.href) {
                return data.itunesImage.$.href;
            }
        }

        // Try standard image field
        if (data.image) {
            if (typeof data.image === "string") {
                return data.image;
            }
            if (data.image.url) {
                return data.image.url;
            }
        }

        return undefined;
    }

    /**
     * Find audio enclosure in episode
     */
    private findAudioEnclosure(
        item: any
    ): { url: string; type?: string; length?: string } | null {
        // Check enclosure field
        if (item.enclosure) {
            const enc = item.enclosure;
            if (enc.url && this.isAudioMimeType(enc.type)) {
                return {
                    url: enc.url,
                    type: enc.type,
                    length: enc.length,
                };
            }
        }

        // Check enclosures array
        if (Array.isArray(item.enclosures)) {
            for (const enc of item.enclosures) {
                if (enc.url && this.isAudioMimeType(enc.type)) {
                    return {
                        url: enc.url,
                        type: enc.type,
                        length: enc.length,
                    };
                }
            }
        }

        return null;
    }

    /**
     * Check if MIME type is audio
     */
    private isAudioMimeType(mimeType?: string): boolean {
        if (!mimeType) return false;
        return (
            mimeType.startsWith("audio/") ||
            mimeType.includes("mpeg") ||
            mimeType.includes("mp3") ||
            mimeType.includes("m4a")
        );
    }

    /**
     * Parse iTunes duration format
     * Supports: "HH:MM:SS", "MM:SS", or just seconds
     */
    private parseDuration(duration?: string): number {
        if (!duration) return 0;

        // If it's already a number (seconds)
        const asNumber = parseInt(duration);
        if (!isNaN(asNumber) && asNumber.toString() === duration) {
            return asNumber;
        }

        // Parse time format (HH:MM:SS or MM:SS)
        const parts = duration.split(":").map((p) => parseInt(p));
        if (parts.length === 3) {
            // HH:MM:SS
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else if (parts.length === 2) {
            // MM:SS
            return parts[0] * 60 + parts[1];
        }

        return 0;
    }

    /**
     * Parse explicit flag
     */
    private parseExplicit(explicit?: string): boolean {
        if (!explicit) return false;
        const lower = explicit.toLowerCase();
        return lower === "yes" || lower === "true" || lower === "explicit";
    }

    /**
     * Extract iTunes ID from feed
     */
    private extractItunesId(feed: any): string | undefined {
        // Try to extract from feed link (e.g., https://podcasts.apple.com/us/podcast/podcast-name/id123456789)
        if (feed.link) {
            const match = feed.link.match(/\/id(\d+)/);
            if (match) {
                return match[1];
            }
        }

        // Try from feed image URL
        if (feed.image?.url) {
            const match = feed.image.url.match(/\/id(\d+)/);
            if (match) {
                return match[1];
            }
        }

        return undefined;
    }
}

export const rssParserService = new RSSParserService();
