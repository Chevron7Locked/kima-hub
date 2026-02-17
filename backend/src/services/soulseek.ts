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
import { redisClient } from "../utils/redis";
import {
    soulseekConnectionStatus,
    soulseekSearchesTotal,
    soulseekSearchDuration,
    soulseekDownloadsTotal,
    soulseekDownloadDuration
} from "../utils/metrics";

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
    private readonly DOWNLOAD_TIMEOUT_INITIAL = 120000;
    private readonly DOWNLOAD_TIMEOUT_RETRY = 60000;
    private readonly MAX_DOWNLOAD_RETRIES = 20;

    private readonly FAILURE_THRESHOLD = 3;
    private readonly FAILURE_WINDOW = 300000;
    private readonly FAILED_USER_TTL = 86400;

    private activeDownloads = 0;
    private maxConcurrentDownloads = 0;

    private userConnectionCooldowns = new Map<string, number>();
    private readonly USER_CONNECTION_COOLDOWN = 5000; // Increased from 3s to 5s
    private cooldownCleanupInterval: NodeJS.Timeout | null = null;

    private connectedAt: Date | null = null;
    private lastSuccessfulSearch: Date | null = null;
    private consecutiveEmptySearches = 0;
    private totalSearches = 0;
    private totalSuccessfulSearches = 0;
    private readonly MAX_CONSECUTIVE_EMPTY = 20; // Increased from 10 to reduce reconnect spam

    // slskd-inspired timeout values (from slskd.example.yml)
    private readonly CONNECT_TIMEOUT = 10000; // 10s (slskd default)
    private readonly LOGIN_TIMEOUT = 10000; // 10s (reduced from 15s)

    constructor() {
        this.connectEagerly();
    }

    private async connectEagerly(): Promise<void> {
        try {
            const settings = await this.getSettings();
            if (!settings.enabled || !settings.username || !settings.password) {
                return;
            }
            sessionLog("SOULSEEK", "Attempting eager connection on startup...", "DEBUG");
            await this.ensureConnected();
            sessionLog("SOULSEEK", "Eager connection successful", "DEBUG");
        } catch (err: any) {
            sessionLog("SOULSEEK", `Eager connection failed (will retry on use): ${err.message}`, "DEBUG");
        }
    }

    private async getSettings() {
        const settings = await getSystemSettings();

        if (!settings) {
            return {
                enabled: process.env.SOULSEEK_ENABLED === 'true',
                username: process.env.SOULSEEK_USERNAME,
                password: process.env.SOULSEEK_PASSWORD,
                downloadPath: process.env.SOULSEEK_DOWNLOAD_PATH,
            };
        }

        if (settings.soulseekEnabled === false) {
            throw new Error('Soulseek is disabled in settings');
        }

        const username = settings.soulseekUsername || process.env.SOULSEEK_USERNAME;
        const password = settings.soulseekPassword || process.env.SOULSEEK_PASSWORD;

        return {
            enabled: settings.soulseekEnabled ?? !!(username && password),
            username,
            password,
            downloadPath: settings.soulseekDownloadPath || process.env.SOULSEEK_DOWNLOAD_PATH,
        };
    }

    async connect(): Promise<void> {
        const settings = await this.getSettings();

        if (!settings.enabled) {
            throw new Error('Soulseek is not enabled');
        }

        if (!settings.username || !settings.password) {
            throw new Error("Soulseek credentials not configured");
        }

        sessionLog("SOULSEEK", `Connecting as ${settings.username}...`);

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
            await this.client.login(
                settings.username,
                settings.password,
                this.LOGIN_TIMEOUT // 10s (slskd default, reduced from 15s)
            );
            sessionLog("SOULSEEK", "Login successful", "DEBUG");
        } catch (err: any) {
            sessionLog("SOULSEEK", `Login failed: ${err.message}`, "ERROR");
            throw err;
        }

        this.connectedAt = new Date();
        this.consecutiveEmptySearches = 0;
        this.failedConnectionAttempts = 0; // Reset on successful connection
        soulseekConnectionStatus.set(1);
        sessionLog("SOULSEEK", "Connected to Soulseek network");

        // Periodic cleanup of expired cooldown entries to prevent memory leak
        if (!this.cooldownCleanupInterval) {
            this.cooldownCleanupInterval = setInterval(() => {
                const now = Date.now();
                for (const [username, cooldownUntil] of this.userConnectionCooldowns.entries()) {
                    if (now >= cooldownUntil) {
                        this.userConnectionCooldowns.delete(username);
                    }
                }
            }, 5 * 60 * 1000);
        }

        // Handle unexpected server disconnection at service level
        // This ensures reconnection goes through ensureConnected() with proper
        // distributed locking and backoff, not the client's own scheduleReconnect
        this.client.server.conn.once('close', () => {
            sessionLog("SOULSEEK", "Server connection closed unexpectedly", "WARN");
            if (this.client) {
                try {
                    this.client.destroy();
                } catch {
                    // ignore cleanup errors
                }
            }
            this.client = null;
            this.connectedAt = null;
            soulseekConnectionStatus.set(0);
        });
    }

    /**
     * Calculate exponential backoff delay with jitter.
     * Base: 2^n * 1000ms, capped at 5 minutes.
     * Jitter: +/- 25% randomization to prevent thundering herd.
     */
    private getReconnectDelay(): number {
        if (this.failedConnectionAttempts === 0) {
            return 0;
        }
        const exponentialDelay = Math.pow(2, this.failedConnectionAttempts - 1) * 1000;
        const cappedDelay = Math.min(exponentialDelay, this.MAX_BACKOFF_MS);
        const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
        return Math.round(cappedDelay + jitter);
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
        if (this.cooldownCleanupInterval) {
            clearInterval(this.cooldownCleanupInterval);
            this.cooldownCleanupInterval = null;
        }
        if (this.client) {
            try {
                this.client.destroy();
            } catch {
                // ignore cleanup errors
            }
        }
        this.client = null;
        this.connectedAt = null;
    }

    /**
     * Check if the server connection is alive.
     * Does NOT disconnect for inactivity - TCP keepalive handles dead connection detection.
     * slskd disables inactivity timeout for server connections (inactivityTimeout: -1).
     */
    private checkConnectionHealth(): boolean {
        if (!this.client || !this.client.loggedIn) {
            return false;
        }

        if (this.client.server.conn.destroyed || !this.client.server.conn.writable) {
            sessionLog("SOULSEEK", "Server socket is dead - needs reconnect", "WARN");
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
                // Another caller is connecting - wait for it instead of failing
                sessionLog("SOULSEEK", "Connection already in progress - waiting for it to complete", "DEBUG");
                await this.waitForConnection();
                return;
            }
            throw error;
        }
    }

    /**
     * Wait for an in-progress connection attempt to complete.
     * Polls connection state with short intervals instead of failing immediately.
     */
    private async waitForConnection(maxWaitMs: number = 30000): Promise<void> {
        const pollInterval = 500;
        const deadline = Date.now() + maxWaitMs;

        while (Date.now() < deadline) {
            // If a connectPromise exists, wait on it directly
            if (this.connectPromise) {
                try {
                    await this.connectPromise;
                    return;
                } catch {
                    // Connection attempt failed - caller will retry on next use
                    throw new Error('Soulseek connection attempt failed');
                }
            }

            // Already connected? Done.
            if (this.client && this.client.loggedIn) {
                return;
            }

            // Poll - connection may be in progress in another process
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        throw new Error('Timed out waiting for Soulseek connection');
    }

    isConnected(): boolean {
        return this.client !== null && this.client.loggedIn;
    }

    async isAvailable(): Promise<boolean> {
        try {
            const settings = await this.getSettings();
            return !!(settings.username && settings.password);
        } catch {
            return false;
        }
    }

    async getStatus(): Promise<{
        connected: boolean;
        username: string | null;
    }> {
        try {
            const settings = await this.getSettings();
            return {
                connected: this.client !== null && this.client.loggedIn,
                username: settings.username || null,
            };
        } catch {
            return {
                connected: this.client !== null && this.client.loggedIn,
                username: null,
            };
        }
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
        const metricsStartTime = Date.now();
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
            soulseekSearchesTotal.inc({ status: 'failed' });
            soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
            return { found: false, bestMatch: null, allMatches: [] };
        }

        if (!this.client) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Client not connected`,
                "ERROR"
            );
            soulseekSearchesTotal.inc({ status: 'failed' });
            soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
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
                searchId,
                onResult
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
                    // If we're now connected, reset counter and allow search
                    // (prevents permanent blocking after recovering from rate limit)
                    if (this.client?.loggedIn) {
                        sessionLog(
                            "SOULSEEK",
                            `[Search #${searchId}] Resetting empty search counter (now connected)`,
                            "DEBUG"
                        );
                        this.consecutiveEmptySearches = 0;
                        // Continue with normal search flow below
                    } else {
                        // Not connected - check if we should wait for backoff
                        const backoffDelay = this.getReconnectDelay();
                        const timeSinceLastAttempt = this.lastConnectAttempt > 0
                            ? Date.now() - this.lastConnectAttempt
                            : backoffDelay + 1;

                        if (timeSinceLastAttempt < backoffDelay) {
                            sessionLog(
                                "SOULSEEK",
                                `[Search #${searchId}] Too many empty searches but respecting backoff period (${Math.round(backoffDelay / 1000)}s)`,
                                "WARN"
                            );
                            soulseekSearchesTotal.inc({ status: 'not_found' });
                            soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
                            return { found: false, bestMatch: null, allMatches: [] };
                        }

                        if (this.activeDownloads > 0) {
                            sessionLog(
                                "SOULSEEK",
                                `[Search #${searchId}] Too many empty searches but ${this.activeDownloads} downloads active, skipping reconnect`,
                                "WARN"
                            );
                            soulseekSearchesTotal.inc({ status: 'not_found' });
                            soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
                            return { found: false, bestMatch: null, allMatches: [] };
                        }

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
                }

                soulseekSearchesTotal.inc({ status: 'not_found' });
                soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
                return { found: false, bestMatch: null, allMatches: [] };
            }

            // Success - reset counters
            this.consecutiveEmptySearches = 0;
            this.lastSuccessfulSearch = new Date();
            this.totalSuccessfulSearches++;

            // Flatten responses to SearchResult format
            const flatResults = this.flattenSearchResults(responses);

            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Found ${flatResults.length} unique results from ${responses.length} peers in ${searchDuration}ms`
            );

            // Rank and filter results
            const rankedMatches = await this.rankAllResults(
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
                soulseekSearchesTotal.inc({ status: 'not_found' });
                soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
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

            soulseekSearchesTotal.inc({ status: 'success' });
            soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);

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
                 // If we're now connected, reset counter and allow search
                 if (this.client?.loggedIn) {
                     sessionLog(
                         "SOULSEEK",
                         `[Search #${searchId}] Resetting failure counter (now connected)`,
                         "DEBUG"
                     );
                     this.consecutiveEmptySearches = 0;
                     // Return the error result, don't retry
                     soulseekSearchesTotal.inc({ status: 'failed' });
                     soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
                     return { found: false, bestMatch: null, allMatches: [] };
                 }

                 // Not connected - check if we should wait for backoff
                 const backoffDelay = this.getReconnectDelay();
                 const timeSinceLastAttempt = this.lastConnectAttempt > 0
                     ? Date.now() - this.lastConnectAttempt
                     : backoffDelay + 1;

                 if (timeSinceLastAttempt < backoffDelay) {
                     sessionLog(
                         "SOULSEEK",
                         `[Search #${searchId}] ${this.consecutiveEmptySearches} consecutive failures but respecting backoff period (${Math.round(backoffDelay / 1000)}s)`,
                         "WARN"
                     );
                     soulseekSearchesTotal.inc({ status: 'failed' });
                     soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
                     return { found: false, bestMatch: null, allMatches: [] };
                 }

                 if (this.activeDownloads > 0) {
                     sessionLog(
                         "SOULSEEK",
                         `[Search #${searchId}] ${this.consecutiveEmptySearches} consecutive failures but ${this.activeDownloads} downloads active, skipping reconnect`,
                         "WARN"
                     );
                     soulseekSearchesTotal.inc({ status: 'failed' });
                     soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
                     return { found: false, bestMatch: null, allMatches: [] };
                 }

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

            soulseekSearchesTotal.inc({ status: 'failed' });
            soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
            return { found: false, bestMatch: null, allMatches: [] };
        }
    }

    private flattenSearchResults(responses: FileSearchResponse[]): SearchResult[] {
        const seen = new Set<string>();
        const results: SearchResult[] = [];

        for (const response of responses) {
            for (const file of response.files) {
                // Create unique key: user + full path (not basename)
                // Using basename caused album files with the same name in
                // different directories to be silently dropped
                const key = `${response.username}:${file.filename}`;

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


     private isUserInCooldown(username: string): boolean {
         const cooldownUntil = this.userConnectionCooldowns.get(username);
         if (!cooldownUntil) return false;

         if (Date.now() >= cooldownUntil) {
             this.userConnectionCooldowns.delete(username);
             return false;
         }

         return true;
     }

private async recordUserFailure(username: string): Promise<void> {
         await this.markUserFailed(username);
         this.userConnectionCooldowns.set(username, Date.now() + this.USER_CONNECTION_COOLDOWN);
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

    private async rankAllResults(
        results: SearchResult[],
        artistName: string,
        trackTitle: string
    ): Promise<TrackMatch[]> {
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
        const blockChecks = await Promise.all(
            results.map(async (file) => ({
                file,
                blocked: await this.isUserBlocked(file.user)
            }))
        );
        const availableResults = blockChecks
            .filter(({ blocked }) => !blocked)
            .map(({ file }) => file);

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
        attemptNumber: number = 0,
        skipCooldown: boolean = false
    ): Promise<{ success: boolean; error?: string }> {
        const downloadStartTime = Date.now();
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

         if (!skipCooldown && this.isUserInCooldown(match.username)) {
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

                    const timeoutId = setTimeout(async () => {
                        if (!resolved) {
                            cleanup();
                            sessionLog(
                                "SOULSEEK",
                                `Download timed out after ${timeout / 1000}s: ${match.filename}`,
                                "WARN"
                            );
                            await this.recordUserFailure(match.username);
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

                    download.stream.on("error", async (err: Error) => {
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
                            await this.recordUserFailure(match.username);
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

writeStream.on("error", async (err: Error) => {
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
                         await this.recordUserFailure(match.username);
                         resolve({
                            success: false,
                            error: `Write error: ${err.message}`,
                        });
                    });
                }
            );

            const duration = (Date.now() - downloadStartTime) / 1000;
            const status = result.success ? 'success' : 'failed';
            soulseekDownloadsTotal.inc({ status });
            soulseekDownloadDuration.observe({ status }, duration);

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
                await this.recordUserFailure(match.username);
            }

            const duration = (Date.now() - downloadStartTime) / 1000;
            soulseekDownloadsTotal.inc({ status: 'failed' });
            soulseekDownloadDuration.observe({ status: 'failed' }, duration);

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

async searchAndDownloadAlbum(
        artistName: string,
        albumName: string,
        tracks: Array<{ title: string; position?: number }>,
        musicPath: string
    ): Promise<{ successful: number; failed: number; files: string[]; errors: string[] }> {
        const results = { successful: 0, failed: 0, files: [] as string[], errors: [] as string[] };

        if (tracks.length === 0) {
            return results;
        }

        const { normalizeArtistName, normalizeTrackTitle } = await import("./soulseek-search-strategies");
        const { stripAlbumEdition, canonicalizeVariousArtists, VARIOUS_ARTISTS_CANONICAL } = await import("../utils/artistNormalization");
        const fuzz = await import("fuzzball");

        // --- Phase 1: Album-level search (1-2 network calls) ---
        const isVA = canonicalizeVariousArtists(artistName) === VARIOUS_ARTISTS_CANONICAL;
        const normalizedAlbum = stripAlbumEdition(albumName);
        const query = isVA
            ? normalizedAlbum
            : `${normalizeArtistName(artistName)} ${normalizedAlbum}`;

        sessionLog("SOULSEEK", `[Album Search] "${query}" (${tracks.length} tracks, VA=${isVA})`);

        // Fix 5: Wrap ensureConnected + search in try/catch
        try {
            await this.ensureConnected();
        } catch (err: any) {
            sessionLog("SOULSEEK", `[Album Search] Connection failed: ${err.message}, falling back to per-track`, "WARN");
            return this.searchAndDownloadBatch(
                tracks.map(t => ({ artist: artistName, title: t.title, album: albumName })),
                musicPath,
                2
            );
        }
        if (!this.client) {
            results.failed = tracks.length;
            results.errors.push("Not connected to Soulseek");
            return results;
        }

        const audioExtensions = [".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"];

        const countAudioFiles = (resps: FileSearchResponse[]): number => {
            let count = 0;
            for (const r of resps) {
                for (const f of r.files) {
                    if (audioExtensions.some(ext => f.filename.toLowerCase().endsWith(ext))) {
                        count++;
                    }
                }
            }
            return count;
        };

        // Fix 5: Wrap search calls in try/catch
        // Fix 6: Reduced timeouts (8s primary, 6s fallback) per slsk-batchdl/Soularr practice
        let responses: FileSearchResponse[];
        let audioCount: number;
        try {
            responses = await this.client.search(query, { timeout: 8000 });
            audioCount = countAudioFiles(responses);

            if (audioCount === 0 && !isVA) {
                sessionLog("SOULSEEK", `[Album Search] Primary query returned 0 audio files, trying album-only fallback`);
                responses = await this.client.search(normalizedAlbum, { timeout: 6000 });
                audioCount = countAudioFiles(responses);
            }
        } catch (err: any) {
            sessionLog("SOULSEEK", `[Album Search] Search failed: ${err.message}, falling back to per-track`, "WARN");
            return this.searchAndDownloadBatch(
                tracks.map(t => ({ artist: artistName, title: t.title, album: albumName })),
                musicPath,
                2
            );
        }

        if (audioCount === 0) {
            sessionLog("SOULSEEK", `[Album Search] No audio results, falling back to per-track batch search`);
            return this.searchAndDownloadBatch(
                tracks.map(t => ({ artist: artistName, title: t.title, album: albumName })),
                musicPath,
                2
            );
        }

        // --- Phase 2: Group results by user + parent directory ---
        const flatResults = this.flattenSearchResults(responses);

        // Fix 3: Filter blocked users before grouping
        const blockChecks = await Promise.all(
            flatResults.map(async (r) => ({
                result: r,
                blocked: await this.isUserBlocked(r.user),
            }))
        );
        const audioResults = blockChecks
            .filter(({ blocked }) => !blocked)
            .map(({ result }) => result)
            .filter(r => audioExtensions.some(ext => r.file.toLowerCase().endsWith(ext)));

        const groups = new Map<string, SearchResult[]>();
        for (const result of audioResults) {
            const parts = result.file.replace(/\\/g, "/").split("/");
            parts.pop();
            const parentDir = parts.join("/");
            const key = `${result.user}|||${parentDir}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(result);
        }

        // Merge multi-disc groups (CD1/CD2/Disc1/Disc2) from same user
        const discPattern = /[\/\\](cd\s*\d+|disc\s*\d+|disk\s*\d+|d\d+)$/i;
        const mergedKeys = new Set<string>();
        for (const [key] of groups) {
            const [username, dir] = key.split("|||");
            if (discPattern.test(dir)) {
                const parentDir = dir.replace(discPattern, "");
                const mergeKey = `${username}|||${parentDir}`;
                if (!mergedKeys.has(key)) {
                    // Find all disc subfolders for this user+parent
                    for (const [otherKey, otherFiles] of groups) {
                        if (otherKey === key) continue;
                        const [otherUser, otherDir] = otherKey.split("|||");
                        if (otherUser === username && discPattern.test(otherDir)) {
                            const otherParent = otherDir.replace(discPattern, "");
                            if (otherParent === parentDir) {
                                // Merge into this group
                                const currentFiles = groups.get(key) || [];
                                currentFiles.push(...otherFiles);
                                groups.set(key, currentFiles);
                                groups.delete(otherKey);
                                mergedKeys.add(otherKey);
                            }
                        }
                    }
                }
            }
        }

        const minGroupSize = Math.min(2, tracks.length);
        for (const [key, files] of groups) {
            if (files.length < minGroupSize) {
                groups.delete(key);
            }
        }

        if (groups.size === 0) {
            sessionLog("SOULSEEK", `[Album Search] No directory groups with ${minGroupSize}+ files, falling back to per-track`);
            return this.searchAndDownloadBatch(
                tracks.map(t => ({ artist: artistName, title: t.title, album: albumName })),
                musicPath,
                2
            );
        }

        sessionLog("SOULSEEK", `[Album Search] Found ${groups.size} directory groups from ${audioResults.length} audio files`);

        // --- Phase 3: Match track titles to filenames in each group ---
        const stripTrackNumber = (name: string): string =>
            name.replace(/^\d{1,3}\s*[-._)\s]\s*/, "");

        const filenameBase = (filePath: string): string => {
            const name = filePath.replace(/\\/g, "/").split("/").pop() || filePath;
            return name.replace(/\.[^.]+$/, "");
        };

        type GroupScore = {
            key: string;
            matchRatio: number;
            matchedTracks: Map<number, SearchResult>;
            unmatchedIndices: number[];
            qualityBonus: number;
            slotsBonus: number;
            speedBonus: number;
            totalScore: number;
        };

        const scoredGroups: GroupScore[] = [];

        for (const [key, files] of groups) {
            const fileInfos = files.map(f => {
                const base = filenameBase(f.file);
                let stripped = stripTrackNumber(base);
                // For VA compilations, strip "Artist - " prefix from filenames
                if (isVA) {
                    const dashIdx = stripped.indexOf(" - ");
                    if (dashIdx > 0) {
                        stripped = stripped.substring(dashIdx + 3);
                    }
                }
                const normalized = normalizeTrackTitle(stripped, 'aggressive').toLowerCase().replace(/[^a-z0-9\s]/g, "");
                return { file: f, base, stripped, normalized };
            });

            type MatchCandidate = { trackIdx: number; fileIdx: number; score: number };
            const candidates: MatchCandidate[] = [];

            for (let ti = 0; ti < tracks.length; ti++) {
                const trackNorm = normalizeTrackTitle(tracks[ti].title, 'aggressive').toLowerCase().replace(/[^a-z0-9\s]/g, "");

                for (let fi = 0; fi < fileInfos.length; fi++) {
                    const fileNorm = fileInfos[fi].normalized;
                    let score = 0;

                    if (fileNorm === trackNorm) {
                        score = 1.0;
                    } else if (fileNorm.includes(trackNorm) || trackNorm.includes(fileNorm)) {
                        score = 0.9;
                    } else {
                        const trackWords = trackNorm.split(/\s+/).filter(w => w.length > 1);
                        const allPresent = trackWords.length > 0 && trackWords.every(w => fileNorm.includes(w));
                        if (allPresent) {
                            score = 0.8;
                        } else {
                            const ratio = fuzz.ratio(trackNorm, fileNorm);
                            if (ratio >= 80) {
                                score = 0.7;
                            } else if (ratio >= 60) {
                                score = 0.5;
                            }
                        }
                    }

                    if (score >= 0.5) {
                        candidates.push({ trackIdx: ti, fileIdx: fi, score });
                    }
                }
            }

            candidates.sort((a, b) => b.score - a.score);
            const usedTracks = new Set<number>();
            const usedFiles = new Set<number>();
            const matchedTracks = new Map<number, SearchResult>();

            for (const c of candidates) {
                if (usedTracks.has(c.trackIdx) || usedFiles.has(c.fileIdx)) continue;
                usedTracks.add(c.trackIdx);
                usedFiles.add(c.fileIdx);
                matchedTracks.set(c.trackIdx, fileInfos[c.fileIdx].file);
            }

            const matchRatio = matchedTracks.size / tracks.length;
            const unmatchedIndices = tracks
                .map((_, i) => i)
                .filter(i => !matchedTracks.has(i));

            let qualityBonus = 0;
            for (const f of files) {
                const lower = f.file.toLowerCase();
                if (lower.endsWith(".flac")) qualityBonus += 3;
                else if (lower.endsWith(".mp3") && (f.bitrate || 0) >= 320) qualityBonus += 2;
                else if (lower.endsWith(".mp3") && (f.bitrate || 0) >= 256) qualityBonus += 1;
            }

            const slotsBonus = files.some(f => f.slots) ? 10 : 0;
            const speedBonus = Math.min(files[0]?.speed || 0, 10000000) / 1000000;
            const totalScore = matchRatio * 100 + qualityBonus + slotsBonus + speedBonus;

            scoredGroups.push({
                key,
                matchRatio,
                matchedTracks,
                unmatchedIndices,
                qualityBonus,
                slotsBonus,
                speedBonus,
                totalScore,
            });
        }

        scoredGroups.sort((a, b) => b.totalScore - a.totalScore);

        // Fix 2: Try multiple groups (top 3) before falling back to per-track
        const groupsToTry = scoredGroups.filter(g => g.matchRatio >= 0.3).slice(0, 3);

        if (groupsToTry.length === 0) {
            const best = scoredGroups[0];
            sessionLog("SOULSEEK", `[Album Search] Best group only ${Math.round(best.matchRatio * 100)}% match, falling back to per-track`);
            return this.searchAndDownloadBatch(
                tracks.map(t => ({ artist: artistName, title: t.title, album: albumName })),
                musicPath,
                2
            );
        }

        // --- Phase 4: Download from best groups, trying next group on failure ---
        const sanitize = (name: string) => name.replace(/[<>:"/\\|?*]/g, "_").trim();
        const downloadedTrackIndices = new Set<number>();

        for (let gi = 0; gi < groupsToTry.length; gi++) {
            const group = groupsToTry[gi];
            const username = group.key.split("|||")[0];

            sessionLog(
                "SOULSEEK",
                `[Album Search] Trying group ${gi + 1}/${groupsToTry.length}: ${username} | ` +
                `match=${Math.round(group.matchRatio * 100)}% (${group.matchedTracks.size}/${tracks.length}) | ` +
                `score=${group.totalScore.toFixed(1)}`
            );

            // Only download tracks not yet successfully downloaded
            const tracksToDownload = new Map<number, SearchResult>();
            for (const [trackIdx, file] of group.matchedTracks) {
                if (!downloadedTrackIndices.has(trackIdx)) {
                    tracksToDownload.set(trackIdx, file);
                }
            }

            if (tracksToDownload.size === 0) continue;

            // Fix 4: Parallel downloads with PQueue (concurrency 3)
            const downloadQueue = new PQueue({ concurrency: 3 });
            let groupFailures = 0;

            const downloadPromises = Array.from(tracksToDownload.entries()).map(([trackIdx, file]) =>
                downloadQueue.add(async () => {
                    const track = tracks[trackIdx];
                    const ext = path.extname(file.file);
                    const destPath = path.join(
                        musicPath,
                        "Singles",
                        sanitize(artistName),
                        sanitize(albumName),
                        sanitize(track.title) + ext
                    );

                    const match: TrackMatch = {
                        username: file.user,
                        filename: file.file.replace(/\\/g, "/").split("/").pop() || file.file,
                        fullPath: file.file,
                        size: file.size,
                        bitRate: file.bitrate,
                        quality: this.getQualityFromFilename(file.file, file.bitrate),
                        score: 100,
                    };

                    const downloadResult = await this.downloadTrack(match, destPath, 0, true);
                    if (downloadResult.success) {
                        results.successful++;
                        results.files.push(destPath);
                        downloadedTrackIndices.add(trackIdx);
                    } else {
                        groupFailures++;
                        results.errors.push(`${track.title}: ${downloadResult.error || "download failed"} (user: ${username})`);
                        sessionLog("SOULSEEK", `[Album Search] Download failed for "${track.title}" from ${username}: ${downloadResult.error}`, "WARN");
                    }
                })
            );

            const downloadSettled = await Promise.allSettled(downloadPromises);
            for (const result of downloadSettled) {
                if (result.status === "rejected") {
                    groupFailures++;
                    sessionLog("SOULSEEK", `[Album Search] Download promise rejected: ${result.reason}`, "ERROR");
                }
            }

            // If this group got all remaining tracks, stop trying groups
            if (downloadedTrackIndices.size >= tracks.length) {
                break;
            }

            // If most downloads from this group failed, user is likely offline -- try next group
            if (groupFailures > 0 && groupFailures >= tracksToDownload.size * 0.5) {
                sessionLog("SOULSEEK", `[Album Search] Group ${gi + 1} had ${groupFailures}/${tracksToDownload.size} failures, trying next group`);
                continue;
            }
        }

        // --- Phase 5: Per-track fallback for remaining undownloaded tracks ---
        const missingIndices = tracks
            .map((_, i) => i)
            .filter(i => !downloadedTrackIndices.has(i));

        if (missingIndices.length > 0) {
            sessionLog(
                "SOULSEEK",
                `[Album Search] ${missingIndices.length} tracks need per-track fallback`
            );

            const fallbackTracks = missingIndices.map(i => ({
                artist: artistName,
                title: tracks[i].title,
                album: albumName,
            }));

            const fallbackResult = await this.searchAndDownloadBatch(fallbackTracks, musicPath, 2);
            results.successful += fallbackResult.successful;
            results.failed += fallbackResult.failed;
            results.files.push(...fallbackResult.files);
            results.errors.push(...fallbackResult.errors);
        }

        sessionLog(
            "SOULSEEK",
            `[Album Search] Complete: ${results.successful}/${tracks.length} tracks downloaded`
        );

        return results;
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
        const searchSettled = await Promise.allSettled(searchPromises);
        const searchResults: Array<{ track: typeof tracks[0]; result: SearchTrackResult }> = [];
        for (const settled of searchSettled) {
            if (settled.status === "fulfilled" && settled.value) {
                searchResults.push(settled.value);
            } else if (settled.status === "rejected") {
                results.failed++;
                results.errors.push(`Search rejected: ${settled.reason}`);
                sessionLog("SOULSEEK", `Batch search promise rejected: ${settled.reason}`, "ERROR");
            }
        }

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

        const downloadSettled = await Promise.allSettled(downloadPromises);
        for (const settled of downloadSettled) {
            if (settled.status === "rejected") {
                results.failed++;
                results.errors.push(`Download rejected: ${settled.reason}`);
                sessionLog("SOULSEEK", `Batch download promise rejected: ${settled.reason}`, "ERROR");
            }
        }

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
        if (this.cooldownCleanupInterval) {
            clearInterval(this.cooldownCleanupInterval);
            this.cooldownCleanupInterval = null;
        }
        if (this.client) {
            try {
                this.client.destroy();
            } catch {
                // ignore cleanup errors
            }
        }
        this.client = null;
        this.connectedAt = null;
        soulseekConnectionStatus.set(0);
        sessionLog("SOULSEEK", "Disconnected");
    }

    /**
     * Reset all backoff/error counters and force immediate reconnection.
     * Use this when credentials change or when manually resetting connection state.
     */
    async resetAndReconnect(): Promise<void> {
        sessionLog("SOULSEEK", "Resetting connection state and forcing reconnect...", "DEBUG");

        // Reset all counters
        this.failedConnectionAttempts = 0;
        this.consecutiveEmptySearches = 0;
        this.lastConnectAttempt = 0;

        // Disconnect if connected
        this.disconnect();

        // Force immediate reconnection (bypasses backoff)
        try {
            await this.ensureConnected(true);
            sessionLog("SOULSEEK", "Reset and reconnect successful", "DEBUG");
        } catch (err: any) {
            sessionLog("SOULSEEK", `Reset and reconnect failed: ${err.message}`, "ERROR");
            throw err;
        }
    }

    async saveSearchSession(sessionId: string, data: unknown, ttlSeconds: number = 300): Promise<void> {
        try {
            const key = `soulseek:search:${sessionId}`;
            await redisClient.setEx(key, ttlSeconds, JSON.stringify(data));
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to save search session: ${err.message}`, "ERROR");
        }
    }

    async getSearchSession(sessionId: string): Promise<unknown> {
        try {
            const key = `soulseek:search:${sessionId}`;
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to get search session: ${err.message}`, "ERROR");
            return null;
        }
    }

    async deleteSearchSession(sessionId: string): Promise<void> {
        try {
            const key = `soulseek:search:${sessionId}`;
            await redisClient.del(key);
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to delete search session: ${err.message}`, "ERROR");
        }
    }

    async listSearchSessions(): Promise<string[]> {
        try {
            const keys = await redisClient.keys('soulseek:search:*');
            return keys.map(key => key.replace('soulseek:search:', ''));
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to list search sessions: ${err.message}`, "ERROR");
            return [];
        }
    }

    async extendSearchSessionTTL(sessionId: string, ttlSeconds: number = 300): Promise<void> {
        try {
            const key = `soulseek:search:${sessionId}`;
            await redisClient.expire(key, ttlSeconds);
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to extend search session TTL: ${err.message}`, "ERROR");
        }
    }

    async markUserFailed(username: string): Promise<void> {
        try {
            const key = `soulseek:failed-user:${username}`;
            const existing = await redisClient.get(key);
            const record = existing ? JSON.parse(existing) : { failures: 0, lastFailure: new Date().toISOString() };

            record.failures++;
            record.lastFailure = new Date().toISOString();

            await redisClient.setEx(key, this.FAILED_USER_TTL, JSON.stringify(record));

            if (record.failures >= this.FAILURE_THRESHOLD) {
                sessionLog(
                    "SOULSEEK",
                    `User ${username} blocked: ${record.failures} failures (24h TTL)`,
                    "WARN"
                );
            }
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to mark user as failed: ${err.message}`, "ERROR");
        }
    }

    async isUserBlocked(username: string): Promise<boolean> {
        try {
            const key = `soulseek:failed-user:${username}`;
            const data = await redisClient.get(key);
            if (!data) return false;

            const record = JSON.parse(data);
            return record.failures >= this.FAILURE_THRESHOLD;
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to check if user is blocked: ${err.message}`, "ERROR");
            return false;
        }
    }

    async clearUserFailures(username: string): Promise<void> {
        try {
            const key = `soulseek:failed-user:${username}`;
            await redisClient.del(key);
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to clear user failures: ${err.message}`, "ERROR");
        }
    }

    async getBlockedUsers(): Promise<string[]> {
        try {
            const keys = await redisClient.keys('soulseek:failed-user:*');
            const blockedUsers: string[] = [];

            for (const key of keys) {
                const data = await redisClient.get(key);
                if (data) {
                    const record = JSON.parse(data);
                    if (record.failures >= this.FAILURE_THRESHOLD) {
                        const username = key.replace('soulseek:failed-user:', '');
                        blockedUsers.push(username);
                    }
                }
            }

            return blockedUsers;
        } catch (err: any) {
            sessionLog("SOULSEEK", `Failed to get blocked users: ${err.message}`, "ERROR");
            return [];
        }
    }
}

export const soulseekService = new SoulseekService();
