import axios from "axios";
import { logger } from "../utils/logger";
import { USER_AGENT } from "../config";
import { rateLimiter } from "./rateLimiter";

const LRCLIB_API = "https://lrclib.net/api";

interface LrclibResponse {
    id: number;
    trackName: string;
    artistName: string;
    albumName: string;
    duration: number;
    instrumental: boolean;
    plainLyrics: string | null;
    syncedLyrics: string | null;
}

export interface LrclibResult {
    plainLyrics: string | null;
    syncedLyrics: string | null;
    id: number;
}

async function fetchLyrics(
    trackName: string,
    artistName: string,
    albumName: string,
    durationSecs: number
): Promise<LrclibResult | null> {
    try {
        const response = await rateLimiter.execute("lrclib", () =>
            axios.get<LrclibResponse>(`${LRCLIB_API}/get`, {
                params: {
                    track_name: trackName,
                    artist_name: artistName,
                    album_name: albumName,
                    duration: Math.round(durationSecs),
                },
                headers: {
                    "User-Agent": USER_AGENT,
                },
                timeout: 5000,
            })
        );

        return {
            plainLyrics: response.data.plainLyrics,
            syncedLyrics: response.data.syncedLyrics,
            id: response.data.id,
        };
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            return null;
        }
        logger.error("[LRCLIB] Failed to fetch lyrics:",
            error instanceof Error ? error.message : String(error));
        throw error;
    }
}

export const lrclibService = { fetchLyrics };
