/**
 * Multi-strategy search for Soulseek P2P network
 *
 * Strategies ordered from simple to complex based on real-world filename patterns.
 * Simpler queries match more actual filenames and should be tried first:
 * 1. Artist + Title (aggressive normalization) - most likely to match
 * 2. Artist + Title (moderate normalization) - balanced approach
 * 3. Title only (aggressive normalization) - fallback when artist name doesn't match
 * 4. Album + Title - fallback for compilation albums
 * 5. Artist + Album + Title - last resort for highly specific searches
 */

import { SlskClient } from "../lib/soulseek/client";
import type { FileSearchResponse } from "../lib/soulseek/messages/from/peer";
import { sessionLog } from "../utils/playlistLogger";

export interface SearchStrategy {
    name: string;
    buildQuery: (artist: string, track: string, album?: string) => string;
    priority: number;
}

/**
 * Strip classical music metadata that doesn't appear in real filenames
 */
function stripClassicalMetadata(title: string): string {
    return title
        // Remove movement numbers: "I.", "II.", "III.", "IV.", etc.
        // Matches Roman numerals (I, V, X combinations) followed by period
        .replace(/\b[IVX]+\.\s*/g, "")
        // Replace colons with spaces (used as separators in classical titles)
        .replace(/:\s*/g, " ")
        // Remove opus/catalog numbers used to identify classical works
        // Op. (Opus), K. (Köchel), BWV (Bach), RV (Vivaldi), Hob. (Haydn), D. (Schubert), WoO (Beethoven)
        .replace(/\b(Op\.|K\.|BWV|RV|Hob\.|D\.|WoO)\s*\d+[a-z]?/gi, "")
        // Remove key signatures that appear in classical titles
        .replace(/\bin\s+[A-G]\s+(Major|Minor|sharp|flat)/gi, "")
        // Remove arrangement notes like "(Arr. for Piano from Concerto)"
        .replace(/\(Arr\.[^)]+\)/gi, "")
        // Remove "inspired by" phrases that don't appear in filenames
        .replace(/inspired by[^,]+,?\s*/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Strip featuring artists from track titles
 */
function stripFeaturingArtists(title: string): string {
    return title
        .replace(/\s*[\(\[]?\s*(feat\.|ft\.|featuring|with)\s+[^\)\]]+[\)\]]?\s*/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Normalize track title with different levels of aggression
 */
export function normalizeTrackTitle(title: string, level: 'aggressive' | 'moderate' | 'minimal'): string {
    let normalized = title
        .replace(/\u2026/g, "")
        .replace(/[\u2018\u2019\u2032`]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\//g, " ")
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/[\u00D7]/g, "x");

    if (level === 'aggressive') {
        normalized = stripFeaturingArtists(normalized);
        normalized = stripClassicalMetadata(normalized);

        const livePatterns = /\s*\([^)]*(?:live|remaster|remix|version|edit|demo|acoustic|radio|single|extended|instrumental)[^)]*\)\s*/gi;
        normalized = normalized.replace(livePatterns, " ");

        const bracketPatterns = /\s*\[[^\]]*(?:live|remaster|remix|version|edit|demo|acoustic|radio|single|extended|instrumental)[^\]]*\]\s*/gi;
        normalized = normalized.replace(bracketPatterns, " ");

        normalized = normalized.replace(
            /\s*-\s*(\d{4}|remaster|live|remix|version|edit|demo|acoustic).*$/i,
            ""
        );
    } else if (level === 'moderate') {
        normalized = stripFeaturingArtists(normalized);
        normalized = stripClassicalMetadata(normalized);

        const strictPatterns = /\s*\([^)]*(?:live|demo|acoustic)[^)]*\)\s*/gi;
        normalized = normalized.replace(strictPatterns, " ");
    }
    // 'minimal' level: no removal, just unicode normalization

    normalized = normalized.replace(/\s+/g, " ").trim();

    if (normalized.length < 3) {
        return title;
    }

    return normalized;
}

/**
 * Normalize artist name
 */
export function normalizeArtistName(artist: string): string {
    const artistLower = artist.toLowerCase();

    // Don't remove "the" for bands like "The The" where it's part of the name
    let normalized = artist;
    if (artistLower.startsWith("the ") && artistLower.length > 4) {
        const remainder = artist.slice(4).trim().toLowerCase();
        // Only strip "The " if the remainder is not also "the"
        if (remainder !== "the") {
            normalized = artist.slice(4);
        }
    }

    return normalized
        .replace(/\s*&\s*/g, " and ")
        .replace(/[\u2018\u2019\u2032`]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .trim();
}

/**
 * All available search strategies, ordered by priority (simple to complex)
 */
export const SEARCH_STRATEGIES: SearchStrategy[] = [
    {
        name: "artist-title-aggressive",
        buildQuery: (artist, track) => {
            const normalizedArtist = normalizeArtistName(artist);
            const normalizedTitle = normalizeTrackTitle(track, 'aggressive');
            return `${normalizedArtist} ${normalizedTitle}`.trim();
        },
        priority: 1,
    },
    {
        name: "artist-title-moderate",
        buildQuery: (artist, track) => {
            const normalizedArtist = normalizeArtistName(artist);
            const normalizedTitle = normalizeTrackTitle(track, 'moderate');
            return `${normalizedArtist} ${normalizedTitle}`.trim();
        },
        priority: 2,
    },
    {
        name: "title-only-aggressive",
        buildQuery: (artist, track) => {
            const normalizedTitle = normalizeTrackTitle(track, 'aggressive');
            return normalizedTitle.trim();
        },
        priority: 3,
    },
    {
        name: "album-title",
        buildQuery: (artist, track, album) => {
            if (!album) return "";
            const normalizedTitle = normalizeTrackTitle(track, 'moderate');
            return `${album} ${normalizedTitle}`.trim();
        },
        priority: 4,
    },
    {
        name: "artist-album-title",
        buildQuery: (artist, track, album) => {
            if (!album) return "";
            const normalizedArtist = normalizeArtistName(artist);
            const normalizedTitle = normalizeTrackTitle(track, 'moderate');
            return `${normalizedArtist} ${album} ${normalizedTitle}`.trim();
        },
        priority: 5,
    },
];

/**
 * Execute multi-strategy search with fallbacks
 */
export async function searchWithStrategies(
    client: SlskClient,
    artistName: string,
    trackTitle: string,
    albumName: string | undefined,
    timeoutMs: number,
    searchId: number
): Promise<FileSearchResponse[]> {
    const audioExtensions = [".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"];

    // Build queries once and filter strategies that produce valid queries
    const applicableStrategies = SEARCH_STRATEGIES
        .map(strategy => ({
            strategy,
            query: strategy.buildQuery(artistName, trackTitle, albumName)
        }))
        .filter(({ query }) => query.length > 0);

    let allResponses: FileSearchResponse[] = [];
    let successfulStrategy: string | null = null;

    for (const { strategy, query } of applicableStrategies) {
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Strategy "${strategy.name}": "${query}"`
        );

        try {
            const responses = await client.search(query, { timeout: timeoutMs });

            if (responses && responses.length > 0) {
                // Count audio files in responses
                let audioFileCount = 0;
                for (const response of responses) {
                    for (const file of response.files) {
                        const filename = (file.filename || "").toLowerCase();
                        if (audioExtensions.some(ext => filename.endsWith(ext))) {
                            audioFileCount++;
                        }
                    }
                }

                if (audioFileCount > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `[Search #${searchId}] Strategy "${strategy.name}" found ${audioFileCount} audio files from ${responses.length} users`
                    );
                    allResponses = responses;
                    successfulStrategy = strategy.name;
                    break;
                } else {
                    sessionLog(
                        "SOULSEEK",
                        `[Search #${searchId}] Strategy "${strategy.name}" returned ${responses.length} responses but 0 audio files`,
                        "WARN"
                    );
                }
            } else {
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] Strategy "${strategy.name}" returned 0 results`,
                    "DEBUG"
                );
            }
        } catch (err: any) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Strategy "${strategy.name}" error: ${err.message}`,
                "WARN"
            );
        }
    }

    if (successfulStrategy) {
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Using results from strategy: ${successfulStrategy}`
        );
    } else {
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] All ${applicableStrategies.length} strategies failed to find audio files`,
            "ERROR"
        );
    }

    return allResponses;
}
