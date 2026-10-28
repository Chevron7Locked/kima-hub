/**
 * Soulseek integration using vendored soulseek-ts library.
 * Provides search, download, and batch operations against the Soulseek P2P network.
 */

import path from "path";
import fs from "fs";
import { mkdir } from "fs/promises";
import PQueue from "p-queue";
import { SlskClient, resolveSlskClient } from "../lib/soulseek/client";
import { configureSlskd } from "../lib/soulseek/slskd-client";
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
import { sourcePauseController } from "./sourcePauseController";
import { soulseekConfigured } from "../utils/soulseekConfigured";
import { nameKey, nameWords } from "./nameFold";

export interface SearchResult {
    user: string;
    file: string;
    size: number;
    slots: boolean;
    bitrate?: number;
    speed: number;
}

interface TrackMatch {
    username: string;
    filename: string;
    fullPath: string;
    size: number;
    bitRate?: number;
    quality: string;
    score: number;
}

interface SearchTrackResult {
    found: boolean;
    bestMatch: TrackMatch | null;
    allMatches: TrackMatch[];
}

const sanitizePathPart = (name: string) => name.replace(/[<>:"/\\|?*]/g, "_").trim();

function singlesPath(musicPath: string, artistName: string, albumName: string, fileName: string): string {
    return path.join(
        musicPath,
        "Singles",
        sanitizePathPart(artistName),
        sanitizePathPart(albumName),
        sanitizePathPart(fileName)
    );
}

interface RateLimiterWaiter {
    resolve: () => void;
    reject: (err: Error) => void;
    settled: boolean;
    timeout: NodeJS.Timeout | null;
}

/**
 * Sliding window rate limiter for Soulseek searches.
 * Empirically safe limit from slsk-batchdl: 34 searches / 220s.
 * We use 30/220s for extra safety (~8.2/min).
 */
class SlidingWindowRateLimiter {
    private timestamps: number[] = [];
    private waitQueue: RateLimiterWaiter[] = [];
    private drainTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly maxRequests: number = 30,
        private readonly windowMs: number = 220_000,
        private readonly maxWaitMs: number = 600_000
    ) {}

    async acquire(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        const now = Date.now();
        const windowStart = now - this.windowMs;
        this.timestamps = this.timestamps.filter(t => t > windowStart);

        if (this.timestamps.length < this.maxRequests) {
            this.timestamps.push(now);
            return;
        }

        // Window is full -- wait for the oldest entry to expire
        const oldestInWindow = this.timestamps[0];
        const waitMs = oldestInWindow + this.windowMs - now;

        if (waitMs > this.maxWaitMs) {
            throw new Error(`Rate limiter wait ${Math.round(waitMs / 1000)}s exceeds max ${Math.round(this.maxWaitMs / 1000)}s`);
        }

        return new Promise<void>((resolve, reject) => {
            const entry: RateLimiterWaiter = { resolve, reject, settled: false, timeout: null };
            this.waitQueue.push(entry);

            const onAbort = () => {
                if (entry.settled) return;
                entry.settled = true;
                if (entry.timeout) clearTimeout(entry.timeout);
                const idx = this.waitQueue.indexOf(entry);
                if (idx !== -1) this.waitQueue.splice(idx, 1);
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            };

            signal?.addEventListener('abort', onAbort, { once: true });

            entry.timeout = setTimeout(() => {
                if (entry.settled) return;
                entry.settled = true;
                const idx = this.waitQueue.indexOf(entry);
                if (idx !== -1) {
                    this.waitQueue.splice(idx, 1);
                }
                signal?.removeEventListener('abort', onAbort);
                this.timestamps.push(Date.now());
                resolve();
            }, waitMs);

            if (!this.drainTimer && this.waitQueue.length === 1) {
                this.drainTimer = setTimeout(() => {
                    this.drainTimer = null;
                    this.drainQueue();
                }, waitMs);
            }
        });
    }

    private drainQueue(): void {
        const now = Date.now();
        const windowStart = now - this.windowMs;
        this.timestamps = this.timestamps.filter(t => t > windowStart);

        while (this.waitQueue.length > 0 && this.timestamps.length < this.maxRequests) {
            const entry = this.waitQueue.shift()!;
            if (entry.settled) continue;
            entry.settled = true;
            if (entry.timeout) {
                clearTimeout(entry.timeout);
            }
            this.timestamps.push(now);
            entry.resolve();
        }

        if (this.waitQueue.length > 0 && this.timestamps.length > 0) {
            const oldestInWindow = this.timestamps[0];
            const waitMs = oldestInWindow + this.windowMs - Date.now();
            if (waitMs > 0) {
                this.drainTimer = setTimeout(() => {
                    this.drainTimer = null;
                    this.drainQueue();
                }, waitMs);
            }
        }
    }

    destroy(): void {
        if (this.drainTimer) {
            clearTimeout(this.drainTimer);
            this.drainTimer = null;
        }
        for (const entry of this.waitQueue) {
            if (entry.timeout) {
                clearTimeout(entry.timeout);
            }
            if (!entry.settled) {
                entry.settled = true;
                entry.reject(new Error('Rate limiter destroyed'));
            }
        }
        this.waitQueue = [];
        this.timestamps = [];
    }

    get remaining(): number {
        const windowStart = Date.now() - this.windowMs;
        return Math.max(0, this.maxRequests - this.timestamps.filter(t => t > windowStart).length);
    }

    get waiting(): number {
        return this.waitQueue.length;
    }
}

class SoulseekService {
    private client: InstanceType<typeof SlskClient> | null = null;
    private connecting = false;
    private connectPromise: Promise<void> | null = null;
    private lastConnectAttempt = 0;
    private failedConnectionAttempts = 0;
    private readonly MAX_BACKOFF_MS = 300000; // 5 minutes (slskd practice)
    private readonly DOWNLOAD_TIMEOUT_INITIAL = 120000;
    private readonly DOWNLOAD_TIMEOUT_RETRY = 60000;
    private readonly MAX_DOWNLOAD_RETRIES = 20;

    private readonly FAILURE_THRESHOLD = 3;
    private readonly FAILED_USER_TTL = 86400;

    private activeDownloads = 0;
    private maxConcurrentDownloads = 0;

    private userConnectionCooldowns = new Map<string, number>();
    private readonly USER_CONNECTION_COOLDOWN = 5000; // 5 s before retrying the same user
    private cooldownCleanupInterval: NodeJS.Timeout | null = null;

    private connectedAt: Date | null = null;
    private consecutiveEmptySearches = 0;
    private totalSearches = 0;
    private readonly MAX_CONSECUTIVE_EMPTY = 20; // 20 empty searches in a row force a reconnect

    // slskd-inspired timeouts
    private readonly CONNECT_TIMEOUT = 10000;
    private readonly LOGIN_TIMEOUT = 10000;

    private searchRateLimiter = new SlidingWindowRateLimiter(30, 220_000);

    constructor() {
        this.connectEagerly();
    }

    private async connectEagerly(): Promise<void> {
        try {
            const settings = await this.getSettings();
            const hasCreds = settings.mode === 'slskd' || !!(settings.username && settings.password);
            if (!settings.enabled || !hasCreds) {
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
            const slskdUrl = process.env.SLSKD_URL || null;
            return {
                mode: slskdUrl ? 'slskd' : 'p2p',
                slskdUrl,
                slskdApiKey: process.env.SLSKD_API_KEY || null,
                enabled: process.env.SOULSEEK_ENABLED === 'true' || !!slskdUrl,
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
        const slskdUrl = settings.slskdUrl || process.env.SLSKD_URL || null;
        const slskdApiKey = settings.slskdApiKey || process.env.SLSKD_API_KEY || null;
        // Explicit setting wins; otherwise infer slskd from a configured URL,
        // else fall back to the built-in P2P client.
        const mode = settings.soulseekMode || (slskdUrl ? 'slskd' : 'p2p');
        const isSlskd = mode === 'slskd';

        return {
            mode,
            slskdUrl,
            slskdApiKey,
            // In slskd mode no Kima-side Soulseek credentials are needed (slskd
            // holds its own account), so enablement doesn't hinge on user/pass.
            enabled: settings.soulseekEnabled ?? (isSlskd ? true : !!(username && password)),
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

        const isSlskd = settings.mode === 'slskd';

        if (isSlskd) {
            // slskd carries its own Soulseek account — Kima needs no credentials.
            configureSlskd({ url: settings.slskdUrl, apiKey: settings.slskdApiKey });
            sessionLog("SOULSEEK", `Using slskd backend at ${settings.slskdUrl}...`);
        } else {
            if (!settings.username || !settings.password) {
                throw new Error("Soulseek credentials not configured");
            }
            sessionLog("SOULSEEK", `Connecting as ${settings.username}...`);
        }

        const ClientImpl = resolveSlskClient(settings.mode);
        this.client = new ClientImpl();

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

        // The socket connects asynchronously; the login can only be sent after its 'connect' event.
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

            this.client!.server.conn.once("error", (err: Error) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        try {
            sessionLog("SOULSEEK", "Attempting login to Soulseek server...", "DEBUG");
            await this.client.login(
                settings.username ?? "",
                settings.password ?? "",
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

        // Reconnects go through ensureConnected(), which holds the distributed lock and backoff.
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
        if (!force && this.client && this.client.loggedIn) {
            if (this.checkConnectionHealth()) {
                return;
            }
        }

        if (force && this.client) {
            this.forceDisconnect();
        }

        const lockKey = 'soulseek:connection';
        const lockTtl = 360000; // 6 minutes - exceeds max backoff (5min)

        try {
            await distributedLock.withLock(lockKey, lockTtl, async () => {
                if (!force && this.client && this.client.loggedIn) {
                    if (this.checkConnectionHealth()) {
                        return;
                    }
                }

                if (this.connecting && this.connectPromise) {
                    await this.connectPromise;
                    return;
                }

                if (this.client && !this.client.loggedIn) {
                    this.forceDisconnect();
                }

                // Apply exponential backoff (slskd practice).
                // NOTE: This sleeps inside the distributed lock. Lock TTL (360s) exceeds max
                // backoff (300s). Other callers hitting the lock fall through to waitForConnection()
                // which polls for 30s -- acceptable since long backoffs only occur after many failures.
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
                        await new Promise(resolve => setTimeout(resolve, waitMs));
                    }
                }

                this.connecting = true;
                this.lastConnectAttempt = Date.now();
                this.connectPromise = this.connect();

                try {
                    await this.connectPromise;
                    this.failedConnectionAttempts = 0;
                } catch (err) {
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
            if (this.connectPromise) {
                try {
                    await this.connectPromise;
                    return;
                } catch {
                    throw new Error('Soulseek connection attempt failed');
                }
            }

            if (this.client && this.client.loggedIn) {
                return;
            }

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
            return soulseekConfigured({
                soulseekMode: settings.mode,
                slskdUrl: settings.slskdUrl,
                soulseekUsername: settings.username,
                soulseekPassword: settings.password,
            });
        } catch {
            // A settings read failure counts as not configured.
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
            // A settings read failure still reports the connection, just without the username.
            return {
                connected: this.client !== null && this.client.loggedIn,
                username: null,
            };
        }
    }

    /**
     * Rate-limited search that gates on the sliding window and waits through backoff.
     * Search timeout measures only network time, not rate limiter wait.
     */
    private async rateLimitedSearch(
        query: string,
        options?: { timeout?: number; onResult?: (result: FileSearchResponse) => void; signal?: AbortSignal }
    ): Promise<FileSearchResponse[]> {
        if (options?.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (this.searchRateLimiter.remaining === 0) {
            sessionLog(
                "SOULSEEK",
                `Rate limiter full (${this.searchRateLimiter.waiting} waiting), throttling search`,
                "WARN"
            );
        }
        await this.searchRateLimiter.acquire(options?.signal);
        if (options?.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }
        await this.ensureConnected();
        return this.client!.search(query, options ?? {});
    }

    /** Searches Soulseek for a track, waiting `timeoutMs` for peers to answer. */
    async searchTrack(
        artistName: string,
        trackTitle: string,
        albumName?: string,
        isRetry: boolean = false,
        timeoutMs: number = 15000,
        onResult?: (result: FileSearchResponse) => void,
        signal?: AbortSignal
    ): Promise<SearchTrackResult> {
        if (signal?.aborted) {
            return { found: false, bestMatch: null, allMatches: [] };
        }
        // While 'soulseek' is paused, searches return not-found without using a
        // rate-limiter slot or counting a failure.
        if (await sourcePauseController.isPaused("soulseek")) {
            sessionLog(
                "SOULSEEK",
                `[Search] Source paused; skipping "${trackTitle}" by ${artistName}`,
                "WARN",
            );
            return { found: false, bestMatch: null, allMatches: [] };
        }
        const metricsStartTime = Date.now();
        this.totalSearches++;
        const searchId = this.totalSearches;

        const recordSearch = (status: "success" | "not_found" | "failed") => {
            soulseekSearchesTotal.inc({ status });
            soulseekSearchDuration.observe((Date.now() - metricsStartTime) / 1000);
        };
        const miss = (status: "not_found" | "failed"): SearchTrackResult => {
            recordSearch(status);
            return { found: false, bestMatch: null, allMatches: [] };
        };

        // Pre-flight connection check -- fail fast before consuming rate limiter slots.
        // rateLimitedSearch also calls ensureConnected, but this avoids wasting a slot
        // when credentials are missing or the service is disabled.
        try {
            await this.ensureConnected();
        } catch (err: any) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Connection error: ${err.message}`,
                "ERROR"
            );
            return miss("failed");
        }

        if (!this.client) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Client not connected`,
                "ERROR"
            );
            return miss("failed");
        }

        const { searchWithStrategies } = await import("./soulseek-search-strategies");

        const searchStartTime = Date.now();

        // Inject signal into bound search function so strategies abort on cancellation
        const boundSearch = signal
            ? (query: string, opts?: any) => this.rateLimitedSearch(query, { ...opts, signal })
            : this.rateLimitedSearch.bind(this);

        try {
            const responses = await searchWithStrategies(
                boundSearch,
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

                if (!isRetry && this.consecutiveEmptySearches >= this.MAX_CONSECUTIVE_EMPTY) {
                    return this.recoverFromSearchStreak(
                        searchId,
                        "not_found",
                        "Too many consecutive empty searches",
                        miss,
                        () => this.searchTrack(artistName, trackTitle, albumName, true, timeoutMs, onResult, signal)
                    );
                }

                return miss("not_found");
            }

            this.consecutiveEmptySearches = 0;

            const flatResults = this.flattenSearchResults(responses);

            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Found ${flatResults.length} unique results from ${responses.length} peers in ${searchDuration}ms`
            );

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
                return miss("not_found");
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

            recordSearch("success");

            return {
                found: true,
                bestMatch: best,
                allMatches: rankedMatches,
            };
        } catch (err: any) {
            const searchDuration = Date.now() - searchStartTime;
            // A rate limit pauses only 'soulseek' and is not counted as a failure.
            if (await sourcePauseController.handleRateLimit("soulseek", err)) {
                sessionLog(
                    "SOULSEEK",
                    `[Search #${searchId}] Rate limited — 'soulseek' paused; not counted as failure`,
                    "WARN",
                );
                return miss("not_found");
            }
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Search error after ${searchDuration}ms: ${err.message}`,
                "ERROR"
            );
            this.consecutiveEmptySearches++;

            if (!isRetry && this.consecutiveEmptySearches >= this.MAX_CONSECUTIVE_EMPTY) {
                return this.recoverFromSearchStreak(
                    searchId,
                    "failed",
                    `${this.consecutiveEmptySearches} consecutive search failures`,
                    miss,
                    () => this.searchTrack(artistName, trackTitle, albumName, true, timeoutMs, onResult, signal)
                );
            }

            return miss("failed");
        }
    }

    /**
     * After MAX_CONSECUTIVE_EMPTY empty or failed searches in a row. If the
     * connection is back the streak ends; otherwise the client reconnects and
     * `retry` runs, unless the reconnect backoff or an active download says not to.
     */
    private async recoverFromSearchStreak(
        searchId: number,
        outcome: "not_found" | "failed",
        streak: string,
        miss: (status: "not_found" | "failed") => SearchTrackResult,
        retry: () => Promise<SearchTrackResult>
    ): Promise<SearchTrackResult> {
        if (this.client?.loggedIn) {
            sessionLog("SOULSEEK", `[Search #${searchId}] Resetting streak counter (now connected)`, "DEBUG");
            this.consecutiveEmptySearches = 0;
            return miss(outcome);
        }

        const backoffDelay = this.getReconnectDelay();
        const timeSinceLastAttempt = this.lastConnectAttempt > 0
            ? Date.now() - this.lastConnectAttempt
            : backoffDelay + 1;

        if (timeSinceLastAttempt < backoffDelay) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] ${streak} but respecting backoff period (${Math.round(backoffDelay / 1000)}s)`,
                "WARN"
            );
            return miss(outcome);
        }

        if (this.activeDownloads > 0) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] ${streak} but ${this.activeDownloads} downloads active, skipping reconnect`,
                "WARN"
            );
            return miss(outcome);
        }

        sessionLog("SOULSEEK", `[Search #${searchId}] ${streak}, forcing reconnect and retry...`, "WARN");
        this.forceDisconnect();
        await new Promise(resolve => setTimeout(resolve, 100));
        return retry();
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
        // Names fold the one way (nameFold), so an artist or title in any script keeps its letters.
        const normalizedArtist = nameWords(artistName.replace(/\s*&\s*/g, " and ")).replace(/^the\s+/, "");
        const normalizedTitle = nameWords(trackTitle.replace(/\s*&\s*/g, " and ")).replace(/^\d+\s*/, "");

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

        availableResults.sort((a, b) => {
            if (a.slots !== b.slots) return b.slots ? 1 : -1; // slots true first
            return (b.speed || 0) - (a.speed || 0); // then by speed
        });

        const scored = availableResults.map((file) => {
            const filename = (file.file || "").toLowerCase();
            const normalizedFilename = nameKey(filename);
            const shortFilename = filename.split(/[/\\]/).pop() || filename;

            // Score: free upload slot +40, fast connection +15; artist exact +50 or
            // partial +35; title exact +50, all words +40, some words +25; FLAC +30,
            // MP3 320 +20, MP3 256 +10; size in range +10-15. 5 is the minimum.
            let score = 0;

            if (file.slots) score += 40;

            if (file.speed > 1000000) score += 15;
            else if (file.speed > 500000) score += 5;

            const artistNoSpaces = normalizedArtist.replace(/\s/g, "");
            if (artistNoSpaces.length > 0 && normalizedFilename.includes(artistNoSpaces)) {
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

        // Partial matches are kept: slsk-batchdl does minimal filtering and relies on user ranking.
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
                            this.client?.removeDownload(download);
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

                    download.events.on("error", (err: any) => {
                        if (resolved) return;
                        clearTimeout(timeoutId);
                        cleanup();
                        sessionLog(
                            "SOULSEEK",
                            `Download ${download.filename} errored: ${err?.message ?? err}`,
                            "ERROR"
                        );
                        this.client?.removeDownload(download);
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
                            error: err?.message ?? String(err),
                        });
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
                        this.client?.removeDownload(download);
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
                        this.client?.removeDownload(download);
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

        const errors: string[] = [];

        const matchesToTry = allMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${matchesToTry.length}: Trying ${match.username}`
            );

            const destPath = singlesPath(musicPath, artistName, albumName, match.filename);

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
        musicPath: string,
        signal?: AbortSignal
    ): Promise<{ successful: number; failed: number; files: string[]; errors: string[] }> {
        const results = { successful: 0, failed: 0, files: [] as string[], errors: [] as string[] };

        if (signal?.aborted || tracks.length === 0) {
            return results;
        }

        const { prepareArtistForSearch, titleFileScore, titleMatchKey } = await import("./soulseek-search-strategies");
        const { stripAlbumEdition, canonicalizeVariousArtists, VARIOUS_ARTISTS_CANONICAL } = await import("../utils/artistNormalization");

        // Album-level search (1-2 network calls)
        const isVA = canonicalizeVariousArtists(artistName) === VARIOUS_ARTISTS_CANONICAL;
        const normalizedAlbum = stripAlbumEdition(albumName);
        const query = isVA
            ? normalizedAlbum
            : `${prepareArtistForSearch(artistName)} ${normalizedAlbum}`;

        sessionLog("SOULSEEK", `[Album Search] "${query}" (${tracks.length} tracks, VA=${isVA})`);

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

        // Rate-limited searches with reduced timeouts (8s primary, 6s fallback) per slsk-batchdl/Soularr practice
        let responses: FileSearchResponse[];
        let audioCount: number;
        try {
            responses = await this.rateLimitedSearch(query, { timeout: 8000, signal });
            audioCount = countAudioFiles(responses);

            if (audioCount === 0 && !isVA) {
                sessionLog("SOULSEEK", `[Album Search] Primary query returned 0 audio files, trying album-only fallback`);
                responses = await this.rateLimitedSearch(normalizedAlbum, { timeout: 6000, signal });
                audioCount = countAudioFiles(responses);
            }
        } catch (err: any) {
            if (err?.name === 'AbortError') throw err;
            sessionLog("SOULSEEK", `[Album Search] Search failed: ${err.message}, falling back to per-track`, "WARN");
            return this.searchAndDownloadBatch(
                tracks.map(t => ({ artist: artistName, title: t.title, album: albumName })),
                musicPath,
                2,
                signal
            );
        }

        if (audioCount === 0) {
            sessionLog("SOULSEEK", `[Album Search] No audio results, falling back to per-track batch search`);
            return this.searchAndDownloadBatch(
                tracks.map(t => ({ artist: artistName, title: t.title, album: albumName })),
                musicPath,
                2,
                signal
            );
        }

        // Group results by user and parent directory
        const flatResults = this.flattenSearchResults(responses);

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
                if (!mergedKeys.has(key)) {
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
                2,
                signal
            );
        }

        sessionLog("SOULSEEK", `[Album Search] Found ${groups.size} directory groups from ${audioResults.length} audio files`);

        // Match track titles to filenames in each group
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
        const trackKeys = tracks.map((t) => titleMatchKey(t.title));

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
                return { file: f, base, stripped, key: titleMatchKey(stripped) };
            });

            type MatchCandidate = { trackIdx: number; fileIdx: number; score: number };
            const candidates: MatchCandidate[] = [];

            for (let ti = 0; ti < tracks.length; ti++) {
                for (let fi = 0; fi < fileInfos.length; fi++) {
                    const score = titleFileScore(trackKeys[ti], fileInfos[fi].key);
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

        // Try multiple groups (top 3) before falling back to per-track
        const groupsToTry = scoredGroups.filter(g => g.matchRatio >= 0.3).slice(0, 3);

        if (groupsToTry.length === 0) {
            const best = scoredGroups[0];
            sessionLog("SOULSEEK", `[Album Search] Best group only ${Math.round(best.matchRatio * 100)}% match, falling back to per-track`);
            return this.searchAndDownloadBatch(
                tracks.map(t => ({ artist: artistName, title: t.title, album: albumName })),
                musicPath,
                2,
                signal
            );
        }

        // Download from the best groups, trying the next on failure
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

            // Parallel downloads with PQueue (concurrency 3)
            const downloadQueue = new PQueue({ concurrency: 3 });
            let groupFailures = 0;

            signal?.addEventListener('abort', () => { downloadQueue.clear(); }, { once: true });

            const downloadPromises = Array.from(tracksToDownload.entries()).map(([trackIdx, file]) =>
                downloadQueue.add(async () => {
                    if (signal?.aborted) return;

                    const track = tracks[trackIdx];
                    const ext = path.extname(file.file);
                    const destPath = singlesPath(musicPath, artistName, albumName, track.title + ext);

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
                }, signal ? { signal } : {})
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

        // Per-track fallback for tracks still not downloaded
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

            const fallbackResult = await this.searchAndDownloadBatch(fallbackTracks, musicPath, 2, signal);
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
        concurrency?: number,
        signal?: AbortSignal
    ): Promise<{
        successful: number;
        failed: number;
        files: string[];
        errors: string[];
    }> {
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

        if (signal?.aborted) return results;

        const downloadQueue = new PQueue({ concurrency: concurrency ?? 2 });
        const searchQueue = new PQueue({ concurrency: concurrency ?? 2 });

        signal?.addEventListener('abort', () => {
            searchQueue.clear();
            downloadQueue.clear();
        }, { once: true });

        sessionLog(
            "SOULSEEK",
            `Searching for ${tracks.length} tracks with concurrency ${concurrency ?? 2}...`
        );
        const searchPromises = tracks.map((track) =>
            searchQueue.add(() =>
                this.searchTrack(track.artist, track.title, track.album, false, 15000, undefined, signal).then((result) => ({
                    track,
                    result,
                })),
                signal ? { signal } : {}
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
                    musicPath,
                    signal
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
            }, signal ? { signal } : {})
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
        musicPath: string,
        signal?: AbortSignal
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        const errors: string[] = [];
        const matchesToTry = allMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            if (signal?.aborted) {
                return { success: false, error: 'Import cancelled' };
            }
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${matchesToTry.length}: Trying ${match.username}`
            );

            const destPath = singlesPath(musicPath, artistName, albumName, match.filename);

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
        this.searchRateLimiter.destroy();
        this.searchRateLimiter = new SlidingWindowRateLimiter(30, 220_000);
        soulseekConnectionStatus.set(0);
        sessionLog("SOULSEEK", "Disconnected");
    }

    /**
     * Reset all backoff/error counters and force immediate reconnection.
     * Use this when credentials change or when manually resetting connection state.
     */
    async resetAndReconnect(): Promise<void> {
        sessionLog("SOULSEEK", "Resetting connection state and forcing reconnect...", "DEBUG");

        this.failedConnectionAttempts = 0;
        this.consecutiveEmptySearches = 0;
        this.lastConnectAttempt = 0;

        this.disconnect();

        try {
            await this.ensureConnected(true);
            sessionLog("SOULSEEK", "Reset and reconnect successful", "DEBUG");
        } catch (err: any) {
            sessionLog("SOULSEEK", `Reset and reconnect failed: ${err.message}`, "ERROR");
            throw err;
        }
    }

    async markUserFailed(username: string): Promise<void> {
        try {
            const key = `soulseek:failed-user:${username}`;
            const existing = await redisClient.get(key);
            const record = existing ? JSON.parse(existing) : { failures: 0, lastFailure: new Date().toISOString() };

            record.failures++;
            record.lastFailure = new Date().toISOString();

            await redisClient.setex(key, this.FAILED_USER_TTL, JSON.stringify(record));

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
}

export const soulseekService = new SoulseekService();
