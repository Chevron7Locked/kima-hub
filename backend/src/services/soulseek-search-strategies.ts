/**
 * Soulseek search strategies, simplest first since simpler queries match more
 * filenames: artist + title (aggressive, then moderate normalisation), title
 * only, album + title, then artist + album + title.
 */

import type { FileSearchResponse } from "../lib/soulseek/messages/from/peer";
import * as fuzz from "fuzzball";
import { sessionLog } from "../utils/playlistLogger";
import { nameWords } from "./nameFold";

export type SearchFn = (
    query: string,
    options?: { timeout?: number; onResult?: (result: FileSearchResponse) => void }
) => Promise<FileSearchResponse[]>;

interface SearchStrategy {
    name: string;
    buildQuery: (artist: string, track: string, album?: string) => string;
}

/** Strips classical metadata (movements, catalogue numbers, keys, arrangements) that real filenames lack. */
function stripClassicalMetadata(title: string): string {
    return title
        // Movement numbers: "I.", "II.", "IV."
        .replace(/\b[IVX]+\.\s*/g, "")
        .replace(/:\s*/g, " ")
        // Catalogue numbers: Op., K., BWV, RV, Hob., D., WoO.
        .replace(/\b(Op\.|K\.|BWV|RV|Hob\.|D\.|WoO)\s*\d+[a-z]?/gi, "")
        .replace(/\bin\s+[A-G]\s+(Major|Minor|sharp|flat)/gi, "")
        // Arrangement notes: "(Arr. for Piano from Concerto)"
        .replace(/\(Arr\.[^)]+\)/gi, "")
        .replace(/inspired by[^,]+,?\s*/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

function stripFeaturingArtists(title: string): string {
    return title
        .replace(/\s*[\(\[]?\s*(feat\.|ft\.|featuring|with)\s+[^\)\]]+[\)\]]?\s*/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** A track title or file name (track number and extension stripped) folded for titleFileScore. */
export function titleMatchKey(title: string): string {
    return nameWords(normalizeTrackTitleForSearch(title, "aggressive"));
}

/**
 * How well a file matches a track in an album folder, from their titleMatchKey folds: 1 the same title, 0.9 one holding
 * the other, 0.8 every word of the title present, 0.7 or 0.5 by fuzzy ratio, else 0. A side with no letters or digits
 * scores 0.
 */
export function titleFileScore(trackKey: string, fileKey: string): number {
    if (trackKey === "" || fileKey === "") return 0;
    if (fileKey === trackKey) return 1;
    if (fileKey.includes(trackKey) || trackKey.includes(fileKey)) return 0.9;
    const trackWords = trackKey.split(" ").filter((w) => w.length > 1);
    if (trackWords.length > 0 && trackWords.every((w) => fileKey.includes(w))) return 0.8;
    const ratio = fuzz.ratio(trackKey, fileKey);
    if (ratio >= 80) return 0.7;
    if (ratio >= 60) return 0.5;
    return 0;
}

/**
 * A track title as a search string, at three levels of aggression. Matching
 * against the database uses utils/normalization instead.
 */
export function normalizeTrackTitleForSearch(title: string, level: 'aggressive' | 'moderate' | 'minimal'): string {
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
 * Build a search-friendly artist string: case-preserving, drops a leading
 * "The " (except "The The"), maps "&" to "and", folds smart quotes.
 * Not the DB lookup normalizer — that is utils/artistNormalization.
 */
export function prepareArtistForSearch(artist: string): string {
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

/** The search strategies, simplest first. */
const SEARCH_STRATEGIES: SearchStrategy[] = [
    {
        name: "artist-title-aggressive",
        buildQuery: (artist, track) => {
            const normalizedArtist = prepareArtistForSearch(artist);
            const normalizedTitle = normalizeTrackTitleForSearch(track, 'aggressive');
            return `${normalizedArtist} ${normalizedTitle}`.trim();
        },
    },
    {
        name: "artist-title-moderate",
        buildQuery: (artist, track) => {
            const normalizedArtist = prepareArtistForSearch(artist);
            const normalizedTitle = normalizeTrackTitleForSearch(track, 'moderate');
            return `${normalizedArtist} ${normalizedTitle}`.trim();
        },
    },
    {
        name: "title-only-aggressive",
        buildQuery: (_artist, track) => {
            const normalizedTitle = normalizeTrackTitleForSearch(track, 'aggressive');
            return normalizedTitle.trim();
        },
    },
    {
        name: "album-title",
        buildQuery: (_artist, track, album) => {
            if (!album) return "";
            const normalizedTitle = normalizeTrackTitleForSearch(track, 'moderate');
            return `${album} ${normalizedTitle}`.trim();
        },
    },
    {
        name: "artist-album-title",
        buildQuery: (artist, track, album) => {
            if (!album) return "";
            const normalizedArtist = prepareArtistForSearch(artist);
            const normalizedTitle = normalizeTrackTitleForSearch(track, 'moderate');
            return `${normalizedArtist} ${album} ${normalizedTitle}`.trim();
        },
    },
];

/** Tries each strategy in order until one returns audio files. */
export async function searchWithStrategies(
    search: SearchFn,
    artistName: string,
    trackTitle: string,
    albumName: string | undefined,
    timeoutMs: number,
    searchId: number,
    onResult?: (result: FileSearchResponse) => void
): Promise<FileSearchResponse[]> {
    const audioExtensions = [".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"];

    const applicableStrategies = SEARCH_STRATEGIES
        .map(strategy => ({
            strategy,
            query: strategy.buildQuery(artistName, trackTitle, albumName)
        }))
        .filter(({ query, strategy }) => {
            // Soulseek matches long queries poorly
            if (query.length > 100) {
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] Skipping strategy "${strategy.name}" - query too long (${query.length} chars)`,
                    "DEBUG"
                );
                return false;
            }
            return query.length > 0;
        });

    let allResponses: FileSearchResponse[] = [];
    let successfulStrategy: string | null = null;

    for (const { strategy, query } of applicableStrategies) {
        if (query.length > 80) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] WARNING: Long query (${query.length} chars) may not match filenames`,
                "WARN"
            );
        }

        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Strategy "${strategy.name}": "${query}" (${query.length} chars)`,
            "INFO"
        );

        try {
            const responses = await search(query, {
                timeout: timeoutMs,
                onResult: onResult
            });

            if (responses && responses.length > 0) {
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
