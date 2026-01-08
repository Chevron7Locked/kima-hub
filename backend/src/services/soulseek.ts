/**
 * Direct Soulseek integration using slsk-client
 * Replaces the SLSKD Docker container with native Node.js connection
 */

import slsk from "slsk-client";
import path from "path";
import fs from "fs";
import PQueue from "p-queue";
import { getSystemSettings } from "../utils/systemSettings";
import { sessionLog } from "../utils/playlistLogger";

// slsk-client types
interface SlskClient {
    search(
        opts: { req: string; timeout: number },
        cb: (err: Error | null, results: SearchResult[]) => void
    ): void;
    download(
        opts: { file: SearchResult; path: string },
        cb: (err: Error | null, data?: { buffer: Buffer }) => void
    ): void;
}

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
    allMatches: TrackMatch[]; // All ranked matches for retry
}

class SoulseekService {
    private client: SlskClient | null = null;
    private connecting = false;
    private connectPromise: Promise<void> | null = null;
    private lastConnectAttempt = 0;
    private lastFailedAttempt = 0;
    private readonly RECONNECT_COOLDOWN = 30000; // 30 seconds between reconnect attempts
    private readonly FAILED_RECONNECT_COOLDOWN = 5000; // 5 seconds after failed attempt
    private readonly DOWNLOAD_TIMEOUT_INITIAL = 60000; // 1 minute for first attempt
    private readonly DOWNLOAD_TIMEOUT_RETRY = 30000; // 30 seconds for retries
    private readonly MAX_DOWNLOAD_RETRIES = 5; // Try up to 5 different users (more retries with shorter timeouts)

    // Circuit breaker for failing users
    private failedUsers = new Map<string, { failures: number; lastFailure: Date }>();
    private readonly FAILURE_THRESHOLD = 3; // Block after 3 failures
    private readonly FAILURE_WINDOW = 300000; // 5 minute window

    // Concurrency tracking
    private activeDownloads = 0;
    private maxConcurrentDownloads = 0;

    // Connection health tracking
    private connectedAt: Date | null = null;
    private lastSuccessfulSearch: Date | null = null;
    private consecutiveEmptySearches = 0;
    private totalSearches = 0;
    private totalSuccessfulSearches = 0;
    private readonly MAX_CONSECUTIVE_EMPTY = 3; // After 3 empty searches, force reconnect

    /**
     * Normalize track title for better search results
     * Extracts main song name by removing live performance details, remasters, etc.
     * e.g. "Santa Claus Is Comin' to Town (Live at C.W. Post College, NY - Dec 1975)" → "Santa Claus Is Comin' to Town"
     */
    private normalizeTrackTitle(title: string): string {
        // First, normalize Unicode characters to ASCII equivalents for better search matching
        let normalized = title
            .replace(/…/g, "") // Remove ellipsis (U+2026) - files don't have this
            .replace(/[''′`]/g, "'") // Smart apostrophes → ASCII apostrophe
            .replace(/[""]/g, '"') // Smart quotes → ASCII quotes
            .replace(/\//g, " ") // Slash → space (file names can't have /)
            .replace(/[–—]/g, "-") // En/em dash → hyphen
            .replace(/[×]/g, "x"); // Multiplication sign → x

        // Remove content in parentheses that contains live/remaster/remix info
        const livePatterns =
            /\s*\([^)]*(?:live|remaster|remix|version|edit|demo|acoustic|radio|single|extended|instrumental|feat\.|ft\.|featuring)[^)]*\)\s*/gi;
        normalized = normalized.replace(livePatterns, " ");

        // Also try brackets
        const bracketPatterns =
            /\s*\[[^\]]*(?:live|remaster|remix|version|edit|demo|acoustic|radio|single|extended|instrumental|feat\.|ft\.|featuring)[^\]]*\]\s*/gi;
        normalized = normalized.replace(bracketPatterns, " ");

        // Remove trailing dash content (often contains year or version info)
        normalized = normalized.replace(
            /\s*-\s*(\d{4}|remaster|live|remix|version|edit|demo|acoustic).*$/i,
            ""
        );

        // Clean up whitespace
        normalized = normalized.replace(/\s+/g, " ").trim();

        // If we stripped too much, return original
        if (normalized.length < 3) {
            return title;
        }

        return normalized;
    }

    /**
     * Connect to Soulseek network
     */
    async connect(): Promise<void> {
        const settings = await getSystemSettings();

        if (!settings?.soulseekUsername || !settings?.soulseekPassword) {
            throw new Error("Soulseek credentials not configured");
        }

        sessionLog("SOULSEEK", `Connecting as ${settings.soulseekUsername}...`);

        return new Promise((resolve, reject) => {
            slsk.connect(
                {
                    user: settings.soulseekUsername,
                    pass: settings.soulseekPassword,
                },
                (err: Error | null, client: SlskClient) => {
                    if (err) {
                        sessionLog(
                            "SOULSEEK",
                            `Connection failed: ${err.message}`,
                            "ERROR"
                        );
                        return reject(err);
                    }
                    this.client = client;
                    this.connectedAt = new Date();
                    this.consecutiveEmptySearches = 0;
                    sessionLog("SOULSEEK", "Connected to Soulseek network");
                    resolve();
                }
            );
        });
    }

    /**
     * Force disconnect and clear client state
     */
    private forceDisconnect(): void {
        const uptime = this.connectedAt
            ? Math.round((Date.now() - this.connectedAt.getTime()) / 1000)
            : 0;
        sessionLog(
            "SOULSEEK",
            `Force disconnecting (was connected for ${uptime}s)`,
            "WARN"
        );
        this.client = null;
        this.connectedAt = null;
        this.lastConnectAttempt = 0; // Allow immediate reconnect
    }

    /**
     * Ensure we have an active connection
     * @param force - If true, disconnect and reconnect even if client exists
     */
    private async ensureConnected(force: boolean = false): Promise<void> {
        if (force && this.client) {
            this.forceDisconnect();
        }

        if (this.client) {
            return;
        }

        // Prevent multiple simultaneous connection attempts
        if (this.connecting && this.connectPromise) {
            return this.connectPromise;
        }

        // Short cooldown after FAILED attempts (5s), longer after SUCCESS (30s)
        const now = Date.now();
        
        // If last successful connection was recent, respect cooldown
        if (!force && this.lastConnectAttempt > 0 &&
            now - this.lastConnectAttempt < this.RECONNECT_COOLDOWN) {
            throw new Error(
                "Connection cooldown - please wait before retrying"
            );
        }
        
        // If last FAILED attempt was very recent (5s), wait briefly
        if (!force && this.lastFailedAttempt > 0 &&
            now - this.lastFailedAttempt < this.FAILED_RECONNECT_COOLDOWN) {
            throw new Error(
                "Connection recently failed - please wait before retrying"
            );
        }

        this.connecting = true;

        this.connectPromise = this.connect()
            .then(() => {
                // Only set lastConnectAttempt on SUCCESS
                this.lastConnectAttempt = Date.now();
                this.lastFailedAttempt = 0; // Clear failed tracking
            })
            .catch((err) => {
                // Track failed attempt separately (shorter cooldown)
                this.lastFailedAttempt = Date.now();
                throw err;
            })
            .finally(() => {
                this.connecting = false;
                this.connectPromise = null;
            });

        return this.connectPromise;
    }

    /**
     * Check if connected to Soulseek
     */
    isConnected(): boolean {
        return this.client !== null;
    }

    /**
     * Check if Soulseek is available (credentials configured)
     */
    async isAvailable(): Promise<boolean> {
        try {
            const settings = await getSystemSettings();
            return !!(settings?.soulseekUsername && settings?.soulseekPassword);
        } catch {
            return false;
        }
    }

    /**
     * Get connection status
     */
    async getStatus(): Promise<{
        connected: boolean;
        username: string | null;
    }> {
        const settings = await getSystemSettings();
        return {
            connected: this.client !== null,
            username: settings?.soulseekUsername || null,
        };
    }

    /**
     * Search for a track and return the best match plus alternatives for retry
     */
    async searchTrack(
        artistName: string,
        trackTitle: string,
        isRetry: boolean = false
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

        // Normalize title to extract main song name (removes live/remaster info)
        const normalizedTitle = this.normalizeTrackTitle(trackTitle);
        const useNormalized = normalizedTitle !== trackTitle;

        const query = `${artistName} ${normalizedTitle}`;
        if (useNormalized) {
            sessionLog(
                "SOULSEEK",
                `[Search #${searchId}] Normalized: "${trackTitle}" → "${normalizedTitle}"`
            );
        }
        sessionLog(
            "SOULSEEK",
            `[Search #${searchId}] Searching: "${query}" (connected ${connectionAge}s, ${this.consecutiveEmptySearches} consecutive empty)`
        );

        return new Promise(async (resolve) => {
            const searchStartTime = Date.now();
            this.client!.search(
                {
                    req: query,
                    timeout: 45000, // 45 seconds for individual tracks (popular tracks can return large results)
                },
                async (err, results) => {
                    const searchDuration = Date.now() - searchStartTime;

                    if (err) {
                        sessionLog(
                            "SOULSEEK",
                            `[Search #${searchId}] Search error after ${searchDuration}ms: ${err.message}`,
                            "ERROR"
                        );
                        this.consecutiveEmptySearches++;

                        // If we get an error and haven't retried, force reconnect and try again
                        if (!isRetry && this.consecutiveEmptySearches >= 2) {
                            sessionLog(
                                "SOULSEEK",
                                `[Search #${searchId}] Search error detected, forcing reconnect and retry...`,
                                "WARN"
                            );
                            this.forceDisconnect();
                            return resolve(
                                await this.searchTrack(
                                    artistName,
                                    trackTitle,
                                    true
                                )
                            );
                        }

                        return resolve({
                            found: false,
                            bestMatch: null,
                            allMatches: [],
                        });
                    }

                    if (!results || results.length === 0) {
                        this.consecutiveEmptySearches++;
                        sessionLog(
                            "SOULSEEK",
                            `[Search #${searchId}] No results found after ${searchDuration}ms (${this.consecutiveEmptySearches}/${this.MAX_CONSECUTIVE_EMPTY} consecutive empty)`,
                            "WARN"
                        );

                        // If too many consecutive empty searches, connection might be stale
                        if (
                            !isRetry &&
                            this.consecutiveEmptySearches >=
                                this.MAX_CONSECUTIVE_EMPTY
                        ) {
                            sessionLog(
                                "SOULSEEK",
                                `[Search #${searchId}] Too many consecutive empty searches, forcing reconnect and retry...`,
                                "WARN"
                            );
                            this.forceDisconnect();
                            return resolve(
                                await this.searchTrack(
                                    artistName,
                                    trackTitle,
                                    true
                                )
                            );
                        }

                        return resolve({
                            found: false,
                            bestMatch: null,
                            allMatches: [],
                        });
                    }

                    // Reset consecutive empty counter on successful results
                    this.consecutiveEmptySearches = 0;
                    this.lastSuccessfulSearch = new Date();
                    this.totalSuccessfulSearches++;

                    sessionLog(
                        "SOULSEEK",
                        `[Search #${searchId}] Found ${
                            results.length
                        } results in ${searchDuration}ms (success rate: ${Math.round(
                            (this.totalSuccessfulSearches /
                                this.totalSearches) *
                                100
                        )}%)`
                    );

                    // Filter for audio files with available slots
                    const audioExtensions = [
                        ".flac",
                        ".mp3",
                        ".m4a",
                        ".ogg",
                        ".opus",
                        ".wav",
                        ".aac",
                    ];
                    const audioFiles = results.filter((r) => {
                        const filename = (r.file || "").toLowerCase();
                        const isAudio = audioExtensions.some((ext) =>
                            filename.endsWith(ext)
                        );
                        // Prefer files with slots available (faster download)
                        return isAudio;
                    });

                    if (audioFiles.length === 0) {
                        sessionLog(
                            "SOULSEEK",
                            `[Search #${searchId}] No audio files in ${results.length} results`,
                            "WARN"
                        );
                        return resolve({
                            found: false,
                            bestMatch: null,
                            allMatches: [],
                        });
                    }

                    // Rank and score all results
                    const rankedMatches = this.rankAllResults(
                        audioFiles,
                        artistName,
                        trackTitle
                    );

                    if (rankedMatches.length === 0) {
                        sessionLog(
                            "SOULSEEK",
                            `[Search #${searchId}] No suitable match found from ${audioFiles.length} audio files`,
                            "WARN"
                        );
                        return resolve({
                            found: false,
                            bestMatch: null,
                            allMatches: [],
                        });
                    }

                    const best = rankedMatches[0];
                    sessionLog(
                        "SOULSEEK",
                        `[Search #${searchId}] ✓ MATCH: ${best.filename} | ${
                            best.quality
                        } | ${Math.round(best.size / 1024 / 1024)}MB | User: ${
                            best.username
                        } | Score: ${best.score}`
                    );
                    sessionLog(
                        "SOULSEEK",
                        `[Search #${searchId}] Found ${rankedMatches.length} alternative sources for retry`
                    );

                    resolve({
                        found: true,
                        bestMatch: best,
                        allMatches: rankedMatches,
                    });
                }
            );
        });
    }

    /**
     * Check if a user should be blocked due to recent failures
     */
    private isUserBlocked(username: string): boolean {
        const record = this.failedUsers.get(username);
        if (!record) return false;

        // Clear old failures outside the window
        if (Date.now() - record.lastFailure.getTime() > this.FAILURE_WINDOW) {
            this.failedUsers.delete(username);
            return false;
        }

        return record.failures >= this.FAILURE_THRESHOLD;
    }

    /**
     * Record a user failure for circuit breaker
     */
    private recordUserFailure(username: string): void {
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
                `User ${username} blocked: ${record.failures} failures in ${Math.round(
                    this.FAILURE_WINDOW / 60000
                )}min window`,
                "WARN"
            );
        }
    }

    /**
     * Categorize download errors for smarter retry behavior
     */
    private categorizeError(error: Error): {
        type: "user_offline" | "timeout" | "connection" | "file_not_found" | "unknown";
        skipUser: boolean;
    } {
        const message = error.message.toLowerCase();

        if (message.includes("user not exist") || message.includes("user offline")) {
            return { type: "user_offline", skipUser: true };
        }
        if (message.includes("timed out") || message.includes("timeout")) {
            return { type: "timeout", skipUser: true };
        }
        if (
            message.includes("connection refused") ||
            message.includes("connection reset")
        ) {
            return { type: "connection", skipUser: true };
        }
        if (message.includes("file not found") || message.includes("no such file")) {
            return { type: "file_not_found", skipUser: true };
        }
        return { type: "unknown", skipUser: false };
    }

    /**
     * Rank all search results and return sorted matches (best first)
     * Filters out matches below minimum score threshold and blocked users
     */
    private rankAllResults(
        results: SearchResult[],
        artistName: string,
        trackTitle: string
    ): TrackMatch[] {
        // Normalize search terms for matching
        const normalizedArtist = artistName
            .toLowerCase()
            .replace(/\s*&\s*/g, " and ")
            .replace(/[^a-z0-9\s]/g, "");
        const normalizedTitle = trackTitle
            .toLowerCase()
            .replace(/\s*&\s*/g, " and ")
            .replace(/[^a-z0-9\s]/g, "")
            .replace(/^\d+\s*[-.]?\s*/, ""); // Remove leading track numbers

        // Get first word of artist for fuzzy matching
        const artistFirstWord = normalizedArtist.split(/\s+/)[0];
        // Get first few significant words of title
        const titleWords = normalizedTitle
            .split(/\s+/)
            .filter((w) => w.length > 2)
            .slice(0, 3);

        // Filter out blocked users first
        const availableResults = results.filter(
            (file) => !this.isUserBlocked(file.user)
        );

        const scored = availableResults.map((file) => {
            const filename = (file.file || "").toLowerCase();
            const normalizedFilename = filename.replace(/[^a-z0-9]/g, "");
            const shortFilename = filename.split(/[/\\]/).pop() || filename;

            let score = 0;

            // Strongly prefer files with slots available (+40)
            if (file.slots) score += 40;

            // Prefer high-speed peers
            if (file.speed > 1000000) score += 15; // >1MB/s
            else if (file.speed > 500000) score += 5; // >500KB/s

            // Check if filename contains artist (full or first word)
            if (
                normalizedFilename.includes(normalizedArtist.replace(/\s/g, ""))
            ) {
                score += 50; // Full artist match
            } else if (
                artistFirstWord.length >= 3 &&
                normalizedFilename.includes(artistFirstWord)
            ) {
                score += 35; // Partial artist match (first word)
            }

            // Check if filename contains title (full or partial)
            const titleNoSpaces = normalizedTitle.replace(/\s/g, "");
            if (normalizedFilename.includes(titleNoSpaces)) {
                score += 50; // Full title match
            } else if (
                titleWords.length > 0 &&
                titleWords.every((w) => normalizedFilename.includes(w))
            ) {
                score += 40; // All significant title words match
            } else if (
                titleWords.length > 0 &&
                titleWords.some(
                    (w) => w.length > 4 && normalizedFilename.includes(w)
                )
            ) {
                score += 25; // At least one significant title word matches
            }

            // Prefer FLAC (+30)
            if (filename.endsWith(".flac")) score += 30;
            // Then high-quality MP3 (+20 for 320, +10 for 256)
            else if (filename.endsWith(".mp3") && (file.bitrate || 0) >= 320)
                score += 20;
            else if (filename.endsWith(".mp3") && (file.bitrate || 0) >= 256)
                score += 10;

            // Prefer reasonable file sizes
            const sizeMB = (file.size || 0) / 1024 / 1024;
            if (sizeMB >= 3 && sizeMB <= 100) score += 10;
            if (sizeMB >= 10 && sizeMB <= 50) score += 5; // FLAC range

            // Prefer higher speed peers
            if (file.speed > 1000000) score += 5; // >1MB/s

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

        // Sort by score descending, filter by minimum threshold
        // Score 20+ is acceptable: slots(20) OR artist match(35-50) OR title match(25-50)
        return scored
            .filter((m) => m.score >= 20)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10); // Keep top 10 for retry purposes
    }

    /**
     * Download a track directly to the music library with timeout
     */
    async downloadTrack(
        match: TrackMatch,
        destPath: string,
        attemptNumber: number = 0
    ): Promise<{ success: boolean; error?: string }> {
        // Track active downloads for concurrency monitoring
        this.activeDownloads++;
        this.maxConcurrentDownloads = Math.max(
            this.maxConcurrentDownloads,
            this.activeDownloads
        );
        sessionLog(
            "SOULSEEK",
            `Active downloads: ${this.activeDownloads}/${this.maxConcurrentDownloads} max`
        );

        // Use shorter timeout for retries
        const timeout =
            attemptNumber === 0
                ? this.DOWNLOAD_TIMEOUT_INITIAL
                : this.DOWNLOAD_TIMEOUT_RETRY;
        try {
            await this.ensureConnected();
        } catch (err: any) {
            return { success: false, error: err.message };
        }

        if (!this.client) {
            return { success: false, error: "Not connected" };
        }

        // Ensure destination directory exists
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        sessionLog(
            "SOULSEEK",
            `Downloading from ${match.username}: ${match.filename} -> ${destPath}`
        );

        return new Promise((resolve) => {
            let resolved = false;

            // Timeout handler - progressive timeout based on attempt number
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.activeDownloads--;
                    sessionLog(
                        "SOULSEEK",
                        `Download timed out after ${timeout / 1000}s: ${
                            match.filename
                        }`,
                        "WARN"
                    );
                    // Record user failure for circuit breaker
                    this.recordUserFailure(match.username);
                    // Clean up partial file if it exists
                    if (fs.existsSync(destPath)) {
                        try {
                            fs.unlinkSync(destPath);
                        } catch (e) {
                            // Ignore cleanup errors
                        }
                    }
                    resolve({ success: false, error: "Download timed out" });
                }
            }, timeout);

            // Create a SearchResult object for the download
            const downloadFile: SearchResult = {
                user: match.username,
                file: match.fullPath,
                size: match.size,
                slots: true,
                bitrate: match.bitRate,
                speed: 0,
            };

            this.client!.download(
                {
                    file: downloadFile,
                    path: destPath,
                },
                (err) => {
                    if (resolved) return; // Already timed out
                    resolved = true;
                    clearTimeout(timeoutId);
                    this.activeDownloads--;

                    if (err) {
                        const errorInfo = this.categorizeError(err);
                        sessionLog(
                            "SOULSEEK",
                            `Download failed (${errorInfo.type}): ${err.message}`,
                            "ERROR"
                        );
                        
                        // Record user failure if error indicates user issue
                        if (errorInfo.skipUser) {
                            this.recordUserFailure(match.username);
                        }
                        
                        return resolve({ success: false, error: err.message });
                    }

                    // Verify file was written
                    if (fs.existsSync(destPath)) {
                        const stats = fs.statSync(destPath);
                        sessionLog(
                            "SOULSEEK",
                            `✓ Downloaded: ${match.filename} (${Math.round(
                                stats.size / 1024
                            )}KB)`
                        );
                        resolve({ success: true });
                    } else {
                        sessionLog(
                            "SOULSEEK",
                            "File not found after download",
                            "ERROR"
                        );
                        resolve({ success: false, error: "File not written" });
                    }
                }
            );
        });
    }

    /**
     * Search and download a track in one operation
     * Includes retry logic - tries multiple users if first fails/times out
     */
    async searchAndDownload(
        artistName: string,
        trackTitle: string,
        albumName: string,
        musicPath: string
    ): Promise<{ success: boolean; filePath?: string; error?: string }> {
        // Search for the track
        const searchResult = await this.searchTrack(artistName, trackTitle);

        if (!searchResult.found || searchResult.allMatches.length === 0) {
            return { success: false, error: "No suitable match found" };
        }

        const sanitize = (name: string) =>
            name.replace(/[<>:"/\\|?*]/g, "_").trim();
        const errors: string[] = [];

        // Try up to MAX_DOWNLOAD_RETRIES different users
        const matchesToTry = searchResult.allMatches.slice(
            0,
            this.MAX_DOWNLOAD_RETRIES
        );

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `Attempt ${attempt + 1}/${matchesToTry.length}: Trying ${
                    match.username
                } for ${match.filename}`
            );

            // Build destination path: Singles/Artist/Album/filename
            const destPath = path.join(
                musicPath,
                "Singles",
                sanitize(artistName),
                sanitize(albumName),
                sanitize(match.filename)
            );

            // Download with timeout
            const downloadResult = await this.downloadTrack(match, destPath);

            if (downloadResult.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `✓ Success on attempt ${attempt + 1} (user: ${
                            match.username
                        })`
                    );
                }
                return { success: true, filePath: destPath };
            }

            // Log failure and try next user
            const errorMsg = downloadResult.error || "Unknown error";
            errors.push(`${match.username}: ${errorMsg}`);
            sessionLog(
                "SOULSEEK",
                `Attempt ${
                    attempt + 1
                } failed: ${errorMsg}, trying next user...`,
                "WARN"
            );
        }

        // All attempts failed
        sessionLog(
            "SOULSEEK",
            `All ${matchesToTry.length} download attempts failed for: ${artistName} - ${trackTitle}`,
            "ERROR"
        );
        return {
            success: false,
            error: `All ${matchesToTry.length} attempts failed: ${errors.join(
                "; "
            )}`,
        };
    }

    /**
     * Download best match from pre-searched results
     * Used when search was already done separately (e.g., for retry functionality)
     */
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

        // Try up to MAX_DOWNLOAD_RETRIES different users
        const matchesToTry = allMatches.slice(0, this.MAX_DOWNLOAD_RETRIES);

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${
                    matchesToTry.length
                }: Trying ${match.username}`
            );

            // Build destination path: Singles/Artist/Album/filename
            const destPath = path.join(
                musicPath,
                "Singles",
                sanitize(artistName),
                sanitize(albumName),
                sanitize(match.filename)
            );

            // Download with timeout
            const downloadResult = await this.downloadTrack(match, destPath);

            if (downloadResult.success) {
                if (attempt > 0) {
                    sessionLog(
                        "SOULSEEK",
                        `✓ Success on attempt ${attempt + 1} (user: ${
                            match.username
                        })`
                    );
                }
                return { success: true, filePath: destPath };
            }

            // Log failure and try next user
            const errorMsg = downloadResult.error || "Unknown error";
            errors.push(`${match.username}: ${errorMsg}`);
            sessionLog(
                "SOULSEEK",
                `Attempt ${attempt + 1} failed: ${errorMsg}`,
                "WARN"
            );
        }

        // All attempts failed
        return {
            success: false,
            error: `All ${matchesToTry.length} attempts failed: ${errors.join(
                "; "
            )}`,
        };
    }

    /**
     * Search and download multiple tracks in parallel
     * - Searches run fully parallel (fast, 15s timeout each)
     * - Downloads limited to concurrency of 4 to prevent network saturation
     */
    async searchAndDownloadBatch(
        tracks: Array<{ artist: string; title: string; album: string }>,
        musicPath: string,
        concurrency: number = 4
    ): Promise<{
        successful: number;
        failed: number;
        files: string[];
        errors: string[];
    }> {
        const downloadQueue = new PQueue({ concurrency });
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

        // Phase 1: Search all tracks in parallel (searches are fast)
        sessionLog(
            "SOULSEEK",
            `Searching for ${tracks.length} tracks in parallel...`
        );
        const searchPromises = tracks.map((track) =>
            this.searchTrack(track.artist, track.title).then((result) => ({
                track,
                result,
            }))
        );
        const searchResults = await Promise.all(searchPromises);

        // Phase 2: Queue downloads with concurrency limit
        const tracksWithMatches = searchResults.filter(
            (r) => r.result.found && r.result.allMatches.length > 0
        );
        sessionLog(
            "SOULSEEK",
            `Found matches for ${tracksWithMatches.length}/${tracks.length} tracks, downloading with concurrency ${concurrency}...`
        );

        // Count tracks with no search results as failed
        const noMatchTracks = searchResults.filter(
            (r) => !r.result.found || r.result.allMatches.length === 0
        );
        for (const { track } of noMatchTracks) {
            results.failed++;
            results.errors.push(
                `${track.artist} - ${track.title}: No match found on Soulseek`
            );
        }

        // Queue downloads for tracks with matches
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
                        `${track.artist} - ${track.title}: ${
                            downloadResult.error || "Unknown error"
                        }`
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

    /**
     * Download with retry logic (extracted for use by batch downloads)
     */
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

        for (let attempt = 0; attempt < matchesToTry.length; attempt++) {
            const match = matchesToTry[attempt];

            sessionLog(
                "SOULSEEK",
                `[${artistName} - ${trackTitle}] Attempt ${attempt + 1}/${
                    matchesToTry.length
                }: Trying ${match.username}`
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
                        `[${artistName} - ${trackTitle}] ✓ Success on attempt ${
                            attempt + 1
                        }`
                    );
                }
                return { success: true, filePath: destPath };
            }
            errors.push(`${match.username}: ${result.error}`);
        }

        sessionLog(
            "SOULSEEK",
            `[${artistName} - ${trackTitle}] All ${matchesToTry.length} attempts failed`,
            "ERROR"
        );
        return { success: false, error: errors.join("; ") };
    }

    /**
     * Get quality string from filename/bitrate
     */
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

    /**
     * Disconnect from Soulseek
     */
    disconnect(): void {
        this.client = null;
        sessionLog("SOULSEEK", "Disconnected");
    }
}

// Export singleton instance
export const soulseekService = new SoulseekService();
