import Parser from "rss-parser";
import axios from "axios";
import { logger } from "../utils/logger";
import { guardedAxios } from "../utils/ssrf";
import { UpstreamReplyError } from "../utils/upstream";
import { APP_VERSION } from "../config";

interface RSSPodcast {
    title: string;
    author?: string;
    description?: string;
    imageUrl?: string;
    language?: string;
    explicit?: boolean;
    itunesId?: string;
    /** The feed's own `itunes:category` names, top-level and nested. */
    categoryNames: string[];
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

interface FeedFetchOptions {
    etag?: string | null;
    lastModified?: string | null;
}

interface FeedFetchResult extends ParsedPodcastFeed {
    notModified: false;
    etag?: string;
    lastModified?: string;
}

interface FeedNotModifiedResult {
    notModified: true;
}

type ParseFeedResult = FeedFetchResult | FeedNotModifiedResult;

/** A feed that could not be fetched or read; its cause says which (utils/upstream tells them apart). */
export class FeedReadError extends UpstreamReplyError {
    name = "FeedReadError";
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
     * Parse an RSS podcast feed from a URL. With etag/lastModified (a refresh), sends If-None-Match /
     * If-Modified-Since and answers { notModified: true } on a 304; without them no 304 can come back.
     */
    async parseFeed(feedUrl: string): Promise<FeedFetchResult>;
    async parseFeed(feedUrl: string, options: FeedFetchOptions): Promise<ParseFeedResult>;
    async parseFeed(feedUrl: string, options?: FeedFetchOptions): Promise<ParseFeedResult> {
        try {
            logger.debug(`[RSS PARSER] Fetching feed: ${feedUrl}`);

            const headers: Record<string, string> = {
                "User-Agent": `Kima/${APP_VERSION} (+https://github.com/Chevron7Locked/kima-hub; podcast aggregator)`,
                "Accept": "application/rss+xml, application/xml, text/xml, */*",
                "Accept-Encoding": "gzip, deflate",
            };

            if (options?.etag) {
                headers["If-None-Match"] = options.etag;
            }
            if (options?.lastModified) {
                headers["If-Modified-Since"] = options.lastModified;
            }

            const response = await axios.get(feedUrl, {
                ...guardedAxios,
                headers,
                timeout: 30000,
                maxRedirects: 5,
                validateStatus: (status) => status < 400 || status === 304,
                responseType: "text",
            });

            if (response.status === 304) {
                // Only an answer to a conditional request; anything else is a host breaking the protocol.
                if (!options?.etag && !options?.lastModified) {
                    throw new Error("the host answered 304 Not Modified to a request that named no earlier copy");
                }
                logger.debug(`   Feed not modified (304)`);
                return { notModified: true };
            }

            const xml = typeof response.data === "string" ? response.data : String(response.data);
            const feed = await this.parser.parseString(xml);

            // Extract podcast metadata
            const podcast: RSSPodcast = {
                title: feed.title || "Unknown Podcast",
                author: (feed as any).itunesAuthor || feed.author || undefined,
                description: feed.description || undefined,
                imageUrl: this.extractImageUrl(feed),
                language: feed.language || undefined,
                explicit: this.parseExplicit((feed as any).itunesExplicit),
                itunesId: this.extractItunesId(feed),
                categoryNames: this.categoryNames(feed),
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

            return {
                notModified: false,
                podcast,
                episodes,
                etag: response.headers["etag"] || undefined,
                lastModified: response.headers["last-modified"] || undefined,
            };
        } catch (error: any) {
            logger.error(
                `\n [RSS PARSER] Failed to parse feed:`,
                error.message
            );
            // An upstream reply problem, with the cause attached, so a caller can tell a refused or missing feed
            // from one that is down or unreadable.
            throw Object.assign(new FeedReadError(`Could not read podcast feed: ${error.message}`), { cause: error });
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
        const candidates = [
            item.enclosure,
            ...(Array.isArray(item.enclosures) ? item.enclosures : []),
        ].filter(Boolean);
        for (const enc of candidates) {
            if (enc.url && this.isAudioMimeType(enc.type)) {
                return {
                    url: enc.url,
                    type: enc.type,
                    length: enc.length,
                };
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

    /** The show's `itunes:category` names, top-level and nested, as the feed library read them. */
    private categoryNames(feed: { itunes?: { [key: string]: unknown } }): string[] {
        // The library reads them (rss-parser 3.x) but its types leave `categoriesWithSubs` out.
        const withSubs = (feed.itunes?.categoriesWithSubs ?? []) as Array<{ name: string; subs: Array<{ name: string }> | null }>;
        const names = withSubs.flatMap((c) => [c.name, ...(c.subs ?? []).map((sub) => sub.name)]);
        return [...new Set(names.map((n) => n?.trim()).filter((n): n is string => !!n))];
    }
}

export const rssParserService = new RSSParserService();
