/**
 * Soulseek integration using vendored soulseek-ts library.
 * Provides search, download, and batch operations against the Soulseek P2P network.
 */

import path from "path";
import fs from "fs";
import { mkdir } from "fs/promises";
import PQueue from "p-queue";
import { SlskClient } from "../lib/soulseek/client";
import type { FileSearchResponse } from "../lib/soulseek/messages/from/peer";
import { FileAttribute } from "../lib/soulseek/messages/common";
import { getSystemSettings } from "../utils/systemSettings";
import { sessionLog } from "../utils/playlistLogger";
import { distributedLock } from "../utils/distributedLock";

export interface SearchResult {
    user: string;
    file: string;
    size: number;
    slots: boolean;
    bitrate?: number;
    speed: number;
}

export interface TrackMatch {
    username: string;
    filename: string;
    fullPath: string;
    size: number;
    bitRate?: number;
    quality: string;
    score: number;
}

export interface SearchTrackResult {
    found: boolean;
    bestMatch: TrackMatch | null;
    allMatches: TrackMatch[];
}

export class SoulseekService {
    private client: SlskClient | null = null;
    private connecting = false;
    private connectPromise: Promise<void> | null = null;
    private lastConnectAttempt = 0;
    private failedConnectionAttempts = 0;
    private readonly MAX_BACKOFF_MS = 300000; // 5 minutes (slskd practice)
    private readonly DOWNLOAD_TIMEOUT_INITIAL = 60000;
    private readonly DOWNLOAD_TIMEOUT_RETRY = 30000;
    private readonly MAX_DOWNLOAD_RETRIES = 20;

    private failedUsers = new Map<
        string,
        { failures: number; lastFailure: Date }
    >();
    private readonly FAILURE_THRESHOLD = 3;
    private readonly FAILURE_WINDOW = 300000;

    private activeDownloads = 0;
    private maxConcurrentDownloads = 0;

    private userConnectionCooldowns = new Map<string, number>();
    private readonly USER_CONNECTION_COOLDOWN = 5000; // Increased from 3s to 5s

    private connectedAt: Date | null = null;
    private lastActivity: Date | null = null;
    private lastSuccessfulSearch: Date | null = null;
    private consecutiveEmptySearches = 0;
    private totalSearches = 0;
    private totalSuccessfulSearches = 0;
    private readonly MAX_CONSECUTIVE_EMPTY = 20; // Increased from 10 to reduce reconnect spam

    // slskd-inspired timeout values (from slskd.example.yml)
    private readonly CONNECT_TIMEOUT = 10000; // 10s (slskd default)
    private readonly INACTIVITY_TIMEOUT = 15000; // 15s (slskd default)
    private readonly LOGIN_TIMEOUT = 10000; // 10s (reduced from 15s)

    constructor() {
        setInterval(() => this.cleanupFailedUsers(), 5 * 60 * 1000);
    }

    async connect(): Promise<void> {
        const settings = await getSystemSettings();

        if (!settings?.soulseekUsername || !settings?.soulseekPassword) {
            throw new Error("Soulseek credentials not configured");
        }

        sessionLog("SOULSEEK", `Connecting as ${settings.soulseekUsername}...`);

        this.client = new SlskClient();

        this.client.on("server-error", (error: Error) => {
            sessionLog(
                "SOULSEEK",
                `Server connection error: ${error.message}`,
                "ERROR"
            );
        });

        this.client.on("peer-error", (error: Error) => {
            sessionLog(
                "SOULSEEK",
                `Peer error: ${error.message}`,
                "DEBUG"
            );
        });

        this.client.on("client-error", (error: unknown) => {
            const message =
                error instanceof Error ? error.message : String(error);
            sessionLog(
                "SOULSEEK",
                `Client error: ${message}`,
                "ERROR"
            );
        });

        this.client.on("listen-error", (error: Error) => {
            sessionLog(
                "SOULSEEK",
                `Listen error: ${error.message}`,
                "ERROR"
            );
        });

        // CRITICAL: Wait for server socket to connect before attempting login
        // The SlskClient constructor creates a TCP socket via net.createConnection()
        // which is async. We must wait for 'connect' event before sending login.
        sessionLog("SOULSEEK", "Waiting for server socket connection...", "DEBUG");
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Server socket connection timed out after ${this.CONNECT_TIMEOUT}ms`));
            }, this.CONNECT_TIMEOUT); // 10s (slskd default)

            this.client!.server.conn.once("connect", () => {
                clearTimeout(timeout);
                sessionLog("SOULSEEK", "Server socket connected", "DEBUG");
                resolve();
            });

            this.client!.server.conn.once("error", (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        try {
            sessionLog("SOULSEEK", "Attempting login to Soulseek server...", "DEBUG");
            await this.client.loginAndRemember(
                settings.soulseekUsername,
                settings.soulseekPassword,
                this.LOGIN_TIMEOUT // 10s (slskd default, reduced from 15s)
            );
            sessionLog("SOULSEEK", "Login successful", "DEBUG");
        } catch (err: any) {
            sessionLog("SOULSEEK", `Login failed: ${err.message}`, "ERROR");
            throw err;
        }

        this.connectedAt = new Date();
        this.lastActivity = new Date();
        this.consecutiveEmptySearches = 0;
        this.failedConnectionAttempts = 0; // Reset on successful connection
        sessionLog("SOULSEEK", "Connected to Soulseek network");
    }

    /**
     * Calculate exponential backoff delay based on failed attempts
     * Follows slskd's approach: exponential backoff capped at 5 minutes
     * Pattern: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s (4.26min), then capped at 300s (5min)
     */
    private getReconnectDelay(): number {
        if (this.failedConnectionAttempts === 0) {
            return 0;
        }
        // Exponential: 2^n * 1000ms, capped at 5 minutes
        const exponentialDelay = Math.pow(2, this.failedConnectionAttempts - 1) * 1000;
        return Math.min(exponentialDelay, this.MAX_BACKOFF_MS);
    }

    private forceDisconnect(): void {
        const uptime = this.connectedAt
            ? Math.round((Date.now() - this.connectedAt.getTime()) / 1000)
            : 0;
        sessionLog(
            "SOULSEEK",
            `Force disconnecting (was connected for ${uptime}s)`,
            "DEBUG"
        );
        if (this.client) {
            try {
                this.client.destroy();
            } catch {
                // ignore cleanup errors
            }
        }
        this.client = null;
        this.connectedAt = null;
        this.lastActivity = null;
    }

    /**
     * Check for stale connection and force reconnect if inactive
     * Follows slskd's inactivity timeout (15s)
     */
    private checkConnectionHealth(): boolean {
        if (!this.client || !this.client.loggedIn) {
            return false;
        }

        if (!this.lastActivity) {
            // Initialize on first check after connection
            this.lastActivity = new Date();
            return true;
        }

        const inactiveMs = Date.now() - this.lastActivity.getTime();
        if (inactiveMs > this.INACTIVITY_TIMEOUT) {
            sessionLog(
                "SOULSEEK",
                `Connection inactive for ${Math.round(inactiveMs / 1000)}s (threshold: ${this.INACTIVITY_TIMEOUT / 1000}s) - forcing reconnect`,
                "WARN"
            );
            this.forceDisconnect();
            return false;
        }

        return true;
    }

    private async ensureConnected(force: boolean = false): Promise<void> {
        // Check connection health before using existing connection
        if (!force && this.client && this.client.loggedIn) {
            if (this.checkConnectionHealth()) {
                return;
            }
            // Connection was stale, fall through to reconnect
        }

        if (force && this.client) {
            this.forceDisconnect();
        }

        // Use distributed lock to prevent concurrent connections across processes
        const lockKey = 'soulseek:connection';
        const lockTtl = 360000; // 6 minutes - exceeds max backoff (5min)

        try {
            // withLock handles lock release in its finally block
            // so we don't need to manually check release() success
            await distributedLock.withLock(lockKey, lockTtl, async () => {
                // Double-check after acquiring lock
                if (!force && this.client && this.client.loggedIn) {
                    if (this.checkConnectionHealth()) {
                        return;
                    }
                }

                // Check if another process is already connecting
                if (this.connecting && this.connectPromise) {
                    await this.connectPromise;
                    return;
                }

                // Client exists but not logged in AND not connecting - clean it up
                if (this.client && !this.client.loggedIn) {
                    this.forceDisconnect();
                }

                // Apply exponential backoff (slskd practice)
                const backoffDelay = force ? 0 : this.getReconnectDelay();
                if (backoffDelay > 0) {
                    const now = Date.now();
                    const timeSinceLastAttempt = this.lastConnectAttempt > 0
                        ? now - this.lastConnectAttempt
                        : backoffDelay + 1;

                    if (timeSinceLastAttempt < backoffDelay) {
                        const waitMs = backoffDelay - timeSinceLastAttempt;
                        sessionLog(
                            "SOULSEEK",
                            `Exponential backoff: waiting ${Math.round(waitMs / 1000)}s before reconnect attempt (attempt #${this.failedConnectionAttempts})`,
                            "WARN"
                        );
                        throw new Error(
                            `Connection backoff - wait ${Math.round(waitMs / 1000)}s before retry (attempt ${this.failedConnectionAttempts})`
                        );
                    }
                }

                this.connecting = true;
                this.lastConnectAttempt = Date.now();
                this.connectPromise = this.connect();

                try {
                    await this.connectPromise;
                    // Success - reset failure counter
                    this.failedConnectionAttempts = 0;
                } catch (err) {
                    // Increment failure counter for exponential backoff
                    this.failedConnectionAttempts++;
                    sessionLog(
                        "SOULSEEK",
                        `Connection failed (attempt #${this.failedConnectionAttempts}). Next retry delay: ${Math.round(this.getReconnectDelay() / 1000)}s`,
                        "ERROR"
                    );
                    throw err;
                } finally {
                    this.connecting = false;
                    this.connectPromise = null;
                }
            });
        } catch (error: any) {
            if (error.message.includes('Failed to acquire lock')) {
                sessionLog("SOULSEEK", "Connection already in progress in another process", "DEBUG");
                throw new Error('Soulseek connection already in progress');
            }
            throw error;
        }
    }

    isConnected(): boolean {
        return this.client !== null && this.client.loggedIn;
    }

    async isAvailable(): Promise<boolean> {
        try {
            const settings = await getSystemSettings();
            return !!(settings?.soulseekUsername && settings?.soulseekPassword);
        } catch {
            return false;
        }
    }

    async getStatus(): Promise<{
        connected: boolean;
        username: string | null;
    }> {
        const settings = await getSystemSettings();
        return {
            connected: this.client !== null && this.client.loggedIn,
            username: settings?.soulseekUsername || null,
        };
    }

    /**
     * Search for a track on Soulseek
     *
     * @param timeoutMs Default 15s per research (slsk-batchdl uses 6s, community recommends 10-15s)
     *                  Too long wastes time, too short misses slow peers
     */
    async searchTrack(
        artistName: string,
        trackTitle: string,
        albumName?: string,
        isRetry: boolean = false,
        timeoutMs: number = 15000,
        onResult?: (result: FileSearchResponse) => void
    ): Promise<SearchTrackResult> {
        this.totalSearches++;
        const searchId = this.totalSearches;
        const connectionAge = this.connectedAt
            ? Math.round((Date.now() - this.connectedAt.getTime()) / 1000)
            : 0;

        try {
            await this.ensureConnected();
        } catch (err: any) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Connection error: ${err.message}`,
                "ERROR"
            );
            return { found: false, bestMatch: null, allMatches: [] };
        }

        if (!this.client) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Client not connected`,
                "ERROR"
            );
            return { found: false, bestMatch: null, allMatches: [] };
        }

        // Use multi-strategy search with aggressive normalization
        const { searchWithStrategies } = await import("./soulseek-search-strategies");

        const searchStartTime = Date.now();

        try {
            // Delegate to optimized multi-strategy search
            const responses = await searchWithStrategies(
                this.client,
                artistName,
                trackTitle,
                albumName,
                timeoutMs,
                searchId
            );

            const searchDuration = Date.now() - searchStartTime;

            if (!responses || responses.length === 0) {
                this.consecutiveEmptySearches++;
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] All strategies failed to find audio files after ${searchDuration}ms (${this.consecutiveEmptySearches}/${this.MAX_CONSECUTIVE_EMPTY} consecutive empty)`,
                    "WARN"
                );

                if (
                    !isRetry &&
                    this.consecutiveEmptySearches >= this.MAX_CONSECUTIVE_EMPTY
                ) {
                    sessionLog(
                        "SOULSEEK",
                        `[Search #${searchId}] Too many consecutive empty searches, forcing reconnect and retry...`,
                        "WARN"
                    );
                    this.forceDisconnect();

                    // Wait for disconnect to complete before reconnecting
                    await new Promise(resolve => setTimeout(resolve, 100));

                    return this.searchTrack(
                        artistName,
                        trackTitle,
                        albumName,
                        true,
                        timeoutMs,
                        onResult
                    );
                }

                return { found: false, bestMatch: null, allMatches: [] };
            }

            // Success - reset counters and update activity timestamp
            this.consecutiveEmptySearches = 0;
            this.lastSuccessfulSearch = new Date();
            this.lastActivity = new Date(); // Track activity for health monitoring
            this.totalSuccessfulSearches++;

            // Flatten responses to SearchResult format
            const flatResults = this.flattenSearchResults(responses);

            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Found ${flatResults.length} unique results from ${responses.length} peers in ${searchDuration}ms`
            );

            // Rank and filter results
            const rankedMatches = this.rankAllResults(
                flatResults,
                artistName,
                trackTitle
            );

            if (rankedMatches.length === 0) {
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] No suitable match found after ranking ${flatResults.length} files`,
                    "WARN"
                );
                return { found: false, bestMatch: null, allMatches: [] };
            }

            const best = rankedMatches[0];
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] MATCH: ${best.filename} | ${best.quality} | ${Math.round(best.size / 1024 / 1024)}MB | User: ${best.username} | Score: ${best.score}`
            );
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Found ${rankedMatches.length} alternative sources for retry`
            );

            return {
                found: true,
                bestMatch: best,
                allMatches: rankedMatches,
            };
        } catch (err: any) {
            const searchDuration = Date.now() - searchStartTime;
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Search error after ${searchDuration}ms: ${err.message}`,
                "ERROR"
            );
            this.consecutiveEmptySearches++;

if (!isRetry && this.consecutiveEmptySearches >= this.MAX_CONSECUTIVE_EMPTY) {
                 sessionLog(
                     "SOULSEEK",
                     `[Search #${searchId}] ${this.consecutiveEmptySearches} consecutive search failures - forcing reconnect and retry...`,
                     "WARN"
                 );
                 this.forceDisconnect();

                 // Wait for disconnect to complete before reconnecting
                 await new Promise(resolve => setTimeout(resolve, 100));

                 return this.searchTrack(
                    artistName,
                    trackTitle,
                    albumName,
                    true,
                    timeoutMs,
                    onResult
                );
            }

            return { found: false, bestMatch: null, allMatches: [] };
        }
    }

    private flattenSearchResults(responses: FileSearchResponse[]): SearchResult[] {
        const seen = new Set<string>();
        const results: SearchResult[] = [];

        for (const response of responses) {
            for (const file of response.files) {
                // Create unique key: user + filename (not full path)
                const filename = file.filename.split(/[/\\]/).pop() || file.filename;
                const key = `${response.username}:${filename}`;

                // Skip if we've already seen this user+filename combo
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);

                results.push({
                    user: response.username,
                    file: file.filename,
                    size: Number(file.size),
                    slots: response.slotsFree,
                    bitrate: file.attrs.get(FileAttribute.Bitrate),
                    speed: response.avgSpeed,
                });
            }
        }

        return results;
    }

private isUserBlocked(username: string): boolean {
         const record = this.failedUsers.get(username);
         if (!record) return false;

         if (Date.now() - record.lastFailure.getTime() > this.FAILURE_WINDOW) {
             this.failedUsers.delete(username);
             return false;
         }

         return record.failures >= this.FAILURE_THRESHOLD;
     }

     private isUserInCooldown(username: string): boolean {
         const cooldownUntil = this.userConnectionCooldowns.get(username);
         if (!cooldownUntil) return false;

         if (Date.now() >= cooldownUntil) {
             this.userConnectionCooldowns.delete(username);
             return false;
         }

         return true;
     }

private cleanupFailedUsers(): void {
         const now = Date.now();
         let cleaned = 0;
         for (const [username, record] of this.failedUsers.entries()) {
             if (now - record.lastFailure.getTime() > this.FAILURE_WINDOW) {
                 this.failedUsers.delete(username);
                 cleaned++;
             }
         }
         if (cleaned > 0) {
             sessionLog(
                 "SOULSEEK",
                 `Cleaned up ${cleaned} expired user failure records`
             );
         }

         const cooldownCleanup = Date.now();
         for (const [username, cooldownUntil] of this.userConnectionCooldowns.entries()) {
             if (cooldownCleanup >= cooldownUntil) {
                 this.userConnectionCooldowns.delete(username);
             }
         }
     }

private recordUserFailure(username: string): void {
         const now = Date.now();
         const record = this.failedUsers.get(username) || {
             failures: 0,
             lastFailure: new Date(),
         };
         record.failures++;
         record.lastFailure = new Date();
         this.failedUsers.set(username, record);

         if (record.failures >= this.FAILURE_THRESHOLD) {
             sessionLog(
                 "SOULSEEK",
                 `User ${username} blocked: ${record.failures} failures in ${Math.round(this.FAILURE_WINDOW / 60000)}min window`,
                 "WARN"
             );
         }

         this.userConnectionCooldowns.set(username, now + this.USER_CONNECTION_COOLDOWN);
     }

    private categorizeError(error: Error): {
        type:
            | "user_offline"
            | "timeout"
            | "connection"
            | "file_not_found"
            | "unknown";
        skipUser: boolean;
    } {
        const message = error.message.toLowerCase();

        // User offline or doesn't exist - skip user
        if (
            message.includes("user not exist") ||
            message.includes("user offline") ||
            message.includes("peer connection failed")
        ) {
            return { type: "user_offline", skipUser: true };
        }

        // Timeout errors - skip user (they're too slow)
        if (
            message.includes("timeout") ||
            message.includes("timed out")
        ) {
            return { type: "timeout", skipUser: true };
        }

        // Connection errors - skip user
        if (
            message.includes("connection refused") ||
            message.includes("connection reset") ||
            message.includes("econnrefused") ||
            message.includes("econnreset") ||
            message.includes("epipe")
        ) {
            return { type: "connection", skipUser: true };
        }

        // File errors - don't skip user (file issue, not user issue)
        if (
            message.includes("file not found") ||
            message.includes("no such file")
        ) {
            return { type: "file_not_found", skipUser: false };
        }

        // Unknown errors - be conservative, skip user
        return { type: "unknown", skipUser: true };
    }

    private rankAllResults(
        results: SearchResult[],
        artistName: string,
        trackTitle: string
    ): TrackMatch[] {
        const normalizedArtist = artistName
            .toLowerCase()
            .replace(/^the\s+/, "")
            .replace(/\s*&\s*/g, " and ")
            .replace(/[^a-z0-9\s]/g, "");
        const normalizedTitle = trackTitle
            .toLowerCase()
            .replace(/\s*&\s*/g, " and ")
            .replace(/[^a-z0-9\s]/g, "")
            .replace(/^\d+\s*[-.]?\s*/, "");

        const artistWords = normalizedArtist.split(/\s+/);
        const artistFirstWord = artistWords[0];
        const artistSecondWord =
            artistWords.length > 1 && artistFirstWord.length < 3
                ? artistWords[1]
                : "";
        const titleWords = normalizedTitle
            .split(/\s+/)
            .filter((w) => w.length > 2)
            .slice(0, 3);

        // Prefer active users (have upload slots) but don't require it
        // Strict filtering can cause 0 results → reconnect spam → rate limits
        const availableResults = results.filter(
            (file) => !this.isUserBlocked(file.user)
        );

        // Sort by slots (active users first), then by speed
        availableResults.sort((a, b) => {
            if (a.slots !== b.slots) return b.slots ? 1 : -1; // slots true first
            return (b.speed || 0) - (a.speed || 0); // then by speed
        });

        const scored = availableResults.map((file) => {
            const filename = (file.file || "").toLowerCase();
            const normalizedFilename = filename.replace(/[^a-z0-9]/g, "");
            const shortFilename = filename.split(/[/\\]/).pop() || filename;

            // Scoring system:
            // - Has upload slots: +40 (file is available now)
            // - Fast connection: +15 (quick download)
            // - Artist match: +50 (exact) or +35 (partial)
            // - Title match: +50 (exact) or +40 (all words) or +25 (some words)
            // - FLAC quality: +30, MP3 320: +20, MP3 256: +10
            // - Size in range: +10-15
            // Minimum score 5 = any partial match
            let score = 0;

            if (file.slots) score += 40;

            if (file.speed > 1000000) score += 15;
            else if (file.speed > 500000) score += 5;

            if (
                normalizedFilename.includes(
                    normalizedArtist.replace(/\s/g, "")
                )
            ) {
                score += 50;
            } else if (
                (artistFirstWord.length >= 3 &&
                    normalizedFilename.includes(artistFirstWord)) ||
                (artistSecondWord &&
                    normalizedFilename.includes(artistSecondWord))
            ) {
                score += 35;
            }

            const titleNoSpaces = normalizedTitle.replace(/\s/g, "");
            if (
                titleNoSpaces.length > 0 &&
                normalizedFilename.includes(titleNoSpaces)
            ) {
                score += 50;
            } else if (
                titleWords.length > 0 &&
                titleWords.every((w) => normalizedFilename.includes(w))
            ) {
                score += 40;
            } else if (
                titleWords.length > 0 &&
                titleWords.some(
                    (w) => w.length > 4 && normalizedFilename.includes(w)
                )
            ) {
                score += 25;
            }

            if (filename.endsWith(".flac")) score += 30;
            else if (filename.endsWith(".mp3") && (file.bitrate || 0) >= 320)
                score += 20;
            else if (filename.endsWith(".mp3") && (file.bitrate || 0) >= 256)
                score += 10;

            const sizeMB = (file.size || 0) / 1024 / 1024;
            if (sizeMB >= 3 && sizeMB <= 100) score += 10;
            if (sizeMB >= 10 && sizeMB <= 50) score += 5;

            if (file.speed > 1000000) score += 5;

            const quality = this.getQualityFromFilename(
                file.file,
                file.bitrate
            );

            return {
                username: file.user,
                filename: shortFilename,
                fullPath: file.file,
                size: file.size,
                bitRate: file.bitrate,
                quality,
                score,
            };
        });

        // Lower threshold to 5 - be more lenient with partial matches
        // Soulseek's natural matching is good, don't over-filter
        // Research: slsk-batchdl does minimal filtering, relies on user ranking
        return scored
            .filter((m) => m.score >= 5)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);
    }

    public async downloadTrack(
        match: TrackMatch,
        destPath: string,
        attemptNumber: number = 0
    ): Promise<{ success: boolean; error?: string }> {
        this.activeDownloads++;
        this.maxConcurrentDownloads = Math.max(
            this.maxConcurrentDownloads,
            this.activeDownloads
        );
        sessionLog(
            "SOULSEEK",
            `Active downloads: ${this.activeDownloads}/${this.maxConcurrentDownloads} max`
        );

        const timeout =
            attemptNumber === 0
                ? this.DOWNLOAD_TIMEOUT_INITIAL
                : this.DOWNLOAD_TIMEOUT_RETRY;

        try {
            await this.ensureConnected();
        } catch (err: any) {
            this.activeDownloads--;
            return { success: false, error: err.message };
        }

if (!this.client) {
             this.activeDownloads--;
             return { success: false, error: "Not connected" };
         }

         if (this.isUserInCooldown(match.username)) {
             this.activeDownloads--;
             return { success: false, error: "User in cooldown" };
         }

        const destDir = path.dirname(destPath);
        try {
            await mkdir(destDir, { recursive: true });
        } catch (err: any) {
            sessionLog(
                "SOULSEEK",
                `Failed to create directory ${destDir}: ${err.message}`,
                "ERROR"
            );
            this.activeDownloads--;
            return {
                success: false,
                error: `Cannot create destination directory: ${err.message}`,
            };
        }

        sessionLog(
            "SOULSEEK",
            `Downloading from ${match.username}: ${match.filename} -> ${destPath}`
        );

        // Update activity timestamp at start of download
        this.lastActivity = new Date();

        try {
            const download = await this.client.download(
                match.username,
                match.fullPath
            );

            const writeStream = fs.createWriteStream(destPath);

            const result = await new Promise<{ success: boolean; error?: string }>(
                (resolve) => {
                    let resolved = false;

                    const cleanup = () => {
                        if (!resolved) {
                            resolved = true;
                            this.activeDownloads--;
                        }
                    };

                    const timeoutId = setTimeout(() => {
                        if (!resolved) {
                            cleanup();
                            sessionLog(
                                "SOULSEEK",
                                `Download timed out after ${timeout / 1000}s: ${match.filename}`,
                                "WARN"
                            );
                            this.recordUserFailure(match.username);
                            try {
                                download.stream.destroy();
                            } catch {
                                // ignore
                            }
                            writeStream.destroy();
                            if (fs.existsSync(destPath)) {
                                try {
                                    fs.unlinkSync(destPath);
                                } catch {
                                    // ignore cleanup errors
                                }
                            }
                            resolve({
                                success: false,
                                error: "Download timed out",
                            });
                        }
                    }, timeout);

                    download.stream.pipe(writeStream);

                    download.events.on("complete", () => {
                        if (resolved) return;
                        clearTimeout(timeoutId);
                        cleanup();

                        // Update activity timestamp on successful download
                        this.lastActivity = new Date();

                        if (fs.existsSync(destPath)) {
                            const stats = fs.statSync(destPath);
                            sessionLog(
                                "SOULSEEK",
                                `Downloaded: ${match.filename} (${Math.round(stats.size / 1024)}KB)`
                            );
                            resolve({ success: true });
                        } else {
                            sessionLog(
                                "SOULSEEK",
                                "File not found after download",
                                "ERROR"
                            );
                            resolve({
                                success: false,
                                error: "File not written",
                            });
                        }
                    });

                    download.stream.on("error", (err: Error) => {
                        if (resolved) return;
                        clearTimeout(timeoutId);
                        cleanup();
                        const errorInfo = this.categorizeError(err);
                        sessionLog(
                            "SOULSEEK",
                            `Download failed (${errorInfo.type}): ${err.message}`,
                            "ERROR"
                        );
                        if (errorInfo.skipUser) {
                            this.recordUserFailure(match.username);
                        }
                        writeStream.destroy();
                        if (fs.existsSync(destPath)) {
                            try {
                                fs.unlinkSync(destPath);
                            } catch {
                                // ignore cleanup errors
                            }
                        }
                        resolve({ success: false, error: err.message });
                    });

writeStream.on("error", (err: Error) => {
                         if (resolved) return;
                         clearTimeout(timeoutId);
                         cleanup();
                         sessionLog(
                             "SOULSEEK",
                             `Write stream error: ${err.message}`,
                             "ERROR"
                         );
                         try {
                             download.stream.destroy();
                         } catch {
                             // ignore
                         }
                         this.recordUserFailure(match.username);
                         resolve({
                            success: false,
                            error: `Write error: ${err.message}`,
                        });
                    });
                }
            );

            return result;
        } catch (err: any) {
            this.activeDownloads--;
            const errorInfo = this.categorizeError(err);
            sessionLog(
                "SOULSEEK",
                `Download setup error (${errorInfo.type}): ${err.message}`,
                "ERROR"
            );
            if (errorInfo.skipUser) {
                this.recordUserFailure(match.username);
            }
            return { success: false, error: err.message };
        }
    }

async downloadBestMatch(
        artistName: string,
        trackTitle: string,
        albumName: string,
        allMatches: TrackMatch[],
        musicPath: string
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        if (allMatches.length === 0) {
            return { success: false, error: "No matches provided" };
        }

        const sanitize = (name: string) =>
            name.replace(/[<>:"/\\|?*]/g, "_").trim();
        const errors: string[] = [];

        const matchesToTry = allMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${matchesToTry.length}: Trying ${match.username}`
            );

            const destPath = path.join(
                musicPath,
                "Singles",
                sanitize(artistName),
                sanitize(albumName),
                sanitize(match.filename)
            );

            const downloadResult = await this.downloadTrack(match, destPath);

            if (downloadResult.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `Success on attempt ${attempt + 1} (user: ${match.username})`
                    );
                }
                return { success: true, filePath: destPath };
            }

            const errorMsg = downloadResult.error || "Unknown error";
            errors.push(`${match.username}: ${errorMsg}`);
            sessionLog(
                "SOULSEEK",
                `Attempt ${attempt + 1} failed: ${errorMsg}`,
                "WARN"
            );
        }

        return {
            success: false,
            error: `All ${matchesToTry.length} attempts failed: ${errors.join("; ")}`,
        };
    }

async searchAndDownloadBatch(
          tracks: Array<{ artist: string; title: string; album: string }>,
          musicPath: string,
          concurrency?: number
      ): Promise<{
         successful: number;
         failed: number;
         files: string[];
         errors: string[];
     }> {
         const downloadQueue = new PQueue({ concurrency: concurrency ?? 2 });
         const results: {
             successful: number;
             failed: number;
             files: string[];
             errors: string[];
         } = {
             successful: 0,
             failed: 0,
             files: [],
             errors: [],
         };

         sessionLog(
             "SOULSEEK",
             `Searching for ${tracks.length} tracks with concurrency ${concurrency ?? 2}...`
         );
         const searchQueue = new PQueue({ concurrency: concurrency ?? 2 });
        const searchPromises = tracks.map((track) =>
            searchQueue.add(() =>
                this.searchTrack(track.artist, track.title, track.album).then((result) => ({
                    track,
                    result,
                }))
            )
        );
        const searchResults = await Promise.all(searchPromises);

const tracksWithMatches = searchResults.filter(
             (r) => r.result.found && r.result.allMatches.length > 0
         );
         sessionLog(
             "SOULSEEK",
             `Found matches for ${tracksWithMatches.length}/${tracks.length} tracks, downloading with concurrency ${concurrency ?? 2}...`
         );

        const noMatchTracks = searchResults.filter(
            (r) => !r.result.found || r.result.allMatches.length === 0
        );
        for (const { track } of noMatchTracks) {
            results.failed++;
            results.errors.push(
                `${track.artist} - ${track.title}: No match found on Soulseek`
            );
        }

        const downloadPromises = tracksWithMatches.map(({ track, result }) =>
            downloadQueue.add(async () => {
                const downloadResult = await this.downloadWithRetry(
                    track.artist,
                    track.title,
                    track.album,
                    result.allMatches,
                    musicPath
                );
                if (downloadResult.success && downloadResult.filePath) {
                    results.successful++;
                    results.files.push(downloadResult.filePath);
                } else {
                    results.failed++;
                    results.errors.push(
                        `${track.artist} - ${track.title}: ${downloadResult.error || "Unknown error"}`
                    );
                }
            })
        );

        await Promise.all(downloadPromises);

        sessionLog(
            "SOULSEEK",
            `Batch complete: ${results.successful} succeeded, ${results.failed} failed`
        );

        return results;
    }

private async downloadWithRetry(
         artistName: string,
         trackTitle: string,
         albumName: string,
         allMatches: TrackMatch[],
         musicPath: string
     ): Promise<{ success: boolean; filePath?: string; error?: string }> {
         const sanitize = (name: string) =>
             name.replace(/[<>:"/\\|?*]/g, "_").trim();
         const errors: string[] = [];
         const matchesToTry = allMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

         const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

         for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
             const match = matchesToTry[attempt];

             sessionLog(
                 "SOULSEEK",
                 `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${matchesToTry.length}: Trying ${match.username}`
             );

             const destPath = path.join(
                 musicPath,
                 "Singles",
                 sanitize(artistName),
                 sanitize(albumName),
                 sanitize(match.filename)
             );

             const result = await this.downloadTrack(match, destPath, attempt);
             if (result.success) {
                 if (attempt > 0) {
                     sessionLog(
                         "SOULSEEK",
                         `[${artistName} - ${trackTitle}] Success on attempt ${attempt + 1}`
                     );
                 }
                 return { success: true, filePath: destPath };
             }

             // Log individual download failure for debugging
             sessionLog(
                 "SOULSEEK",
                 `[${artistName} - ${trackTitle}] Attempt ${attempt + 1} failed: ${result.error}`,
                 "WARN"
             );
             errors.push(`${match.username}: ${result.error}`);

             if (attempt < matchesToTry.length - 1) {
                 const delayMs = attempt < 3 ? 1000 : Math.pow(2, attempt - 2) * 1000;
                 sessionLog(
                     "SOULSEEK",
                     `[${artistName} - ${trackTitle}] Waiting ${delayMs}ms before next attempt...`
                 );
                 await delay(delayMs);
             }
         }

         sessionLog(
             "SOULSEEK",
             `[${artistName} - ${trackTitle}] All ${matchesToTry.length} attempts failed`,
             "ERROR"
         );
        return { success: false, error: errors.join("; ") };
    }

    private getQualityFromFilename(filename: string, bitRate?: number): string {
        const lowerFilename = filename.toLowerCase();
        if (lowerFilename.endsWith(".flac")) return "FLAC";
        if (lowerFilename.endsWith(".wav")) return "WAV";
        if (lowerFilename.endsWith(".mp3")) {
            if (bitRate && bitRate >= 320) return "MP3 320";
            if (bitRate && bitRate >= 256) return "MP3 256";
            if (bitRate && bitRate >= 192) return "MP3 192";
            return "MP3";
        }
        if (lowerFilename.endsWith(".m4a") || lowerFilename.endsWith(".aac"))
            return "AAC";
        if (lowerFilename.endsWith(".ogg")) return "OGG";
        if (lowerFilename.endsWith(".opus")) return "OPUS";
        return "Unknown";
    }

    disconnect(): void {
        if (this.client) {
            try {
                this.client.destroy();
            } catch {
                // ignore cleanup errors
            }
        }
        this.client = null;
        this.connectedAt = null;
        sessionLog("SOULSEEK", "Disconnected");
    }
}

export const soulseekService = new SoulseekService();
