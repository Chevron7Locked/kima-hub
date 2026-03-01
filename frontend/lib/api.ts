const AUTH_TOKEN_KEY = "auth_token";
const REFRESH_TOKEN_KEY = "refresh_token";

// Mood Bucket Types (simplified mood system)
export type MoodType =
    | "happy"
    | "sad"
    | "chill"
    | "energetic"
    | "party"
    | "focus"
    | "melancholy"
    | "aggressive"
    | "acoustic";

export interface MoodBucketPreset {
    id: MoodType;
    name: string;
    color: string;
    icon: string;
    trackCount: number;
}

export interface MoodBucketMix {
    id: string;
    mood: MoodType;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[];
    trackCount: number;
    color: string;
    tracks?: ApiData[];
}

interface ApiError extends Error {
    status?: number;
    data?: Record<string, unknown>;
}

interface ServiceTestResult {
    success?: boolean;
    version?: string;
    error?: string;
}

// API response data type - represents unvalidated JSON from the server.
// Using a single suppression here allows all 100+ API methods to return
// properly loose types without scattering suppressions across the file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiData = any;


function toSearchParams(params: Record<string, string | number | boolean | undefined>): URLSearchParams {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            entries[key] = String(value);
        }
    }
    return new URLSearchParams(entries);
}

// Dynamically determine API URL based on configuration
export const getApiBaseUrl = () => {
    // Server-side rendering
    if (typeof window === "undefined") {
        return process.env.BACKEND_URL || "http://127.0.0.1:3006";
    }

    // Explicit env var takes precedence
    if (process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL;
    }

    // Docker all-in-one mode: Use relative URLs (Next.js rewrites will proxy)
    // This is detected by checking if we're on the same port as the frontend
    const frontendPort =
        window.location.port ||
        (window.location.protocol === "https:" ? "443" : "80");
    if (
        frontendPort === "3030" ||
        frontendPort === "443" ||
        frontendPort === "80"
    ) {
        // Use relative paths - Next.js rewrites will proxy to backend
        return "";
    }

    // Development mode: Backend on separate port
    const currentHost = window.location.hostname;
    const apiPort = "3006";
    return `${window.location.protocol}//${currentHost}:${apiPort}`;
};

class ApiClient {
    private baseUrl: string;
    private token: string | null = null;
    private tokenInitialized: boolean = false;

    constructor(baseUrl?: string) {
        // Don't set baseUrl in constructor - determine it dynamically on each request
        this.baseUrl = baseUrl || "";

        // Try to load token synchronously
        if (typeof window !== "undefined") {
            this.token = localStorage.getItem(AUTH_TOKEN_KEY);
            if (this.token) {
                this.tokenInitialized = true;
            }
            // Note: Refresh token is loaded on-demand via getRefreshToken()
        }
    }

    /**
     * Initialize the auth token from storage
     * Call this early in the app lifecycle to ensure the token is loaded
     */
    async initToken(): Promise<string | null> {
        if (typeof window === "undefined") {
            return null;
        }

        const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
        if (storedToken) {
            this.token = storedToken;
        }

        this.tokenInitialized = true;
        return this.token;
    }

    /**
     * Check if token has been initialized
     */
    isTokenInitialized(): boolean {
        return this.tokenInitialized;
    }

    /**
     * Get the current token (may be null)
     */
    getToken(): string | null {
        return this.token;
    }

    // Store JWT token and optionally refresh token
    setToken(token: string, refreshToken?: string) {
        this.token = token;
        if (typeof window !== "undefined") {
            localStorage.setItem(AUTH_TOKEN_KEY, token);
            if (refreshToken) {
                localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
            }
        }
    }

    // Get refresh token from storage
    getRefreshToken(): string | null {
        if (typeof window === "undefined") {
            return null;
        }
        return localStorage.getItem(REFRESH_TOKEN_KEY);
    }

    // Clear both JWT tokens
    clearToken() {
        this.token = null;
        if (typeof window !== "undefined") {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            localStorage.removeItem(REFRESH_TOKEN_KEY);
        }
    }

    // Get the base URL dynamically to support switching between localhost and IP
    private getBaseUrl(): string {
        if (this.baseUrl) {
            return this.baseUrl;
        }
        return getApiBaseUrl();
    }

    /**
     * Refresh the access token using the refresh token
     * @returns true if refresh succeeded, false otherwise
     */
    private async refreshAccessToken(): Promise<boolean> {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) {
            return false;
        }

        try {
            const response = await fetch(
                `${this.getBaseUrl()}/api/auth/refresh`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refreshToken }),
                    credentials: "include",
                }
            );

            if (!response.ok) {
                // Refresh token invalid or expired - clear tokens
                this.clearToken();
                return false;
            }

            const data = await response.json();

            // Store new tokens
            if (data.token) {
                this.setToken(data.token, data.refreshToken);
                return true;
            }

            this.clearToken();
            return false;
        } catch (error) {
            console.error("[API] Token refresh failed:", error);
            this.clearToken();
            return false;
        }
    }

    /**
     * Make an authenticated API request
     * Public method for components that need custom API calls
     */
    async request<T>(
        endpoint: string,
        options: RequestInit & {
            silent404?: boolean;
            _retryCount?: number;
        } = {}
    ): Promise<T> {
        const { silent404, _retryCount = 0, ...fetchOptions } = options;
        const headers: HeadersInit = {
            "Content-Type": "application/json",
            ...fetchOptions.headers,
        };

        // Add Authorization header if token exists
        if (this.token) {
            (headers as Record<string, string>)[
                "Authorization"
            ] = `Bearer ${this.token}`;
        }

        // All API endpoints are prefixed with /api
        const url = `${this.getBaseUrl()}/api${endpoint}`;

        const response = await fetch(url, {
            ...fetchOptions,
            headers,
            credentials: "include", // Still send cookies for backward compatibility
        });

        if (!response.ok) {
            let error: Record<string, unknown>;
            try {
                error = await response.json();
            } catch (_parseError) {
                error = {
                    error: response.statusText || "Request failed",
                    status: response.status,
                    parseError: "Failed to parse error response",
                };
            }

            // Only log non-404 errors (404s are often expected)
            if (!(silent404 && response.status === 404)) {
                console.error(`[API] Request failed: ${url}`, {
                    status: response.status,
                    statusText: response.statusText,
                    error,
                    headers: Object.fromEntries(response.headers.entries()),
                });
            }

            // Handle 401 with token refresh (retry once)
            if (
                response.status === 401 &&
                _retryCount === 0 &&
                endpoint !== "/auth/refresh"
            ) {
                const refreshed = await this.refreshAccessToken();

                if (refreshed) {
                    // Retry the request with new token
                    return this.request<T>(endpoint, {
                        ...options,
                        _retryCount: 1, // Prevent infinite loops
                    });
                }
            }

            if (response.status === 401) {
                const err = new Error("Not authenticated");
                (err as ApiError).status = response.status;
                (err as ApiError).data = error;
                throw err;
            }

            const err = new Error(String(error.error || error.message || "An error occurred"));
            (err as ApiError).status = response.status;
            (err as ApiError).data = error;
            throw err;
        }

        const data = await response.json();
        return data;
    }

    // Generic POST method for convenience
    async post<T = unknown>(endpoint: string, data?: unknown): Promise<T> {
        return this.request<T>(endpoint, {
            method: "POST",
            body: data ? JSON.stringify(data) : undefined,
        });
    }

    // Generic GET method for convenience
    async get<T = unknown>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "GET",
        });
    }

    // Generic DELETE method for convenience
    async delete<T = unknown>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "DELETE",
        });
    }

    // Auth
    async login(username: string, password: string, token?: string): Promise<{
        id: string;
        username: string;
        role: string;
        requires2FA?: boolean;
        onboardingComplete?: boolean;
    }> {
        const data = await this.request<{
            token?: string;
            refreshToken?: string;
            user?: {
                id: string;
                username: string;
                role: string;
                requires2FA?: boolean;
                onboardingComplete?: boolean;
            };
            id?: string;
            username?: string;
            role?: string;
            requires2FA?: boolean;
            onboardingComplete?: boolean;
        }>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password, token }),
        });

        // If login returned JWT tokens, store them
        if (data.token) {
            this.setToken(data.token, data.refreshToken);
        }

        // Return user data in consistent format
        if (data.user) {
            return data.user;
        }
        return {
            id: data.id || "",
            username: data.username || "",
            role: data.role || "",
            requires2FA: data.requires2FA,
            onboardingComplete: data.onboardingComplete,
        };
    }

    async register(username: string, password: string, email?: string) {
        const data = await this.request<{
            id: string;
            username: string;
            role: string;
        }>("/auth/register", {
            method: "POST",
            body: JSON.stringify({ username, password, email }),
        });
        return data;
    }

    async logout() {
        await this.request<void>("/auth/logout", {
            method: "POST",
        });
        // Clear the stored JWT token
        this.clearToken();
    }

    async getCurrentUser() {
        return this.request<{
            id: string;
            username: string;
            role: string;
            onboardingComplete?: boolean;
            enrichmentSettings?: { enabled: boolean; lastRun?: string };
            createdAt: string;
        }>("/auth/me");
    }

    // Library
    async getArtists(params?: {
        limit?: number;
        offset?: number;
        filter?: "owned" | "discovery" | "all";
        sortBy?: string;
    }) {
        return this.request<{
            artists: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/artists?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getRecentlyListened(limit = 10) {
        return this.request<{ items: ApiData[] }>(
            `/library/recently-listened?limit=${limit}`
        );
    }

    async getRecentlyAdded(limit = 10) {
        return this.request<{ artists: ApiData[] }>(
            `/library/recently-added?limit=${limit}`
        );
    }

    async scanLibrary() {
        return this.request<{
            message: string;
            jobId: string;
            musicPath: string;
        }>("/library/scan", {
            method: "POST",
        });
    }

    async getScanStatus(jobId: string) {
        return this.request<{
            status: string;
            progress: number;
            result?: { tracksAdded: number; tracksUpdated: number; tracksRemoved: number };
        }>(`/library/scan/status/${jobId}`);
    }

    async getArtist(id: string) {
        return this.request<ApiData>(`/library/artists/${id}`);
    }

    async getAlbums(params?: {
        artistId?: string;
        limit?: number;
        offset?: number;
        filter?: "owned" | "discovery" | "all";
        sortBy?: string;
    }) {
        return this.request<{
            albums: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/albums?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getAlbum(id: string) {
        return this.request<ApiData>(`/library/albums/${id}`);
    }

    async getTracks(params?: {
        albumId?: string;
        limit?: number;
        offset?: number;
        sortBy?: string;
    }) {
        return this.request<{
            tracks: ApiData[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/tracks?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
    }

    async getShuffledTracks(limit?: number) {
        const params = limit ? `?limit=${limit}` : "";
        return this.request<{
            tracks: ApiData[];
            total: number;
        }>(`/library/tracks/shuffle${params}`);
    }

    async deleteTrack(trackId: string) {
        return this.request<{ message: string }>(`/library/tracks/${trackId}`, {
            method: "DELETE",
        });
    }

    async deleteAlbum(albumId: string) {
        return this.request<{ message: string; deletedFiles?: number }>(
            `/library/albums/${albumId}`,
            {
                method: "DELETE",
            }
        );
    }

    async deleteArtist(artistId: string) {
        return this.request<{ message: string; deletedFiles?: number }>(
            `/library/artists/${artistId}`,
            {
                method: "DELETE",
            }
        );
    }

    async getTrack(id: string) {
        return this.request<ApiData>(`/library/tracks/${id}`);
    }

    async getTrackLyrics(trackId: string) {
        return this.request<{
            plainLyrics: string | null;
            syncedLyrics: string | null;
            source: string;
        }>(`/library/tracks/${trackId}/lyrics`);
    }

    async getRadioTracks(type: string, value?: string, limit = 50) {
        const params = new URLSearchParams({ type, limit: String(limit) });
        if (value) params.append("value", value);
        return this.request<{ tracks: ApiData[] }>(
            `/library/radio?${params.toString()}`
        );
    }

    // Streaming
    getStreamUrl(trackId: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/library/tracks/${trackId}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    /**
     * Get the current token, lazily loading from localStorage if needed.
     * This handles the case where the singleton was created during SSR
     * and this.token wasn't set from localStorage.
     */
    private getCurrentToken(): string | null {
        // If we already have a token, use it
        if (this.token) {
            return this.token;
        }
        // Try to load from localStorage if on client
        if (typeof window !== "undefined") {
            const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
            if (storedToken) {
                this.token = storedToken;
                this.tokenInitialized = true;
                return storedToken;
            }
        }
        return null;
    }

    /**
     * Get the URL for cover art.
     * @param coverId - The cover ID, URL, or path
     * @param size - Optional size in pixels
     * @param includeToken - Include auth token in URL (needed for canvas color extraction)
     */
    getCoverArtUrl(coverId: string, size?: number, includeToken = true): string {
        const baseUrl = this.getBaseUrl();
        const token = includeToken ? this.getCurrentToken() : null;

        // Check if this is an audiobook cover path (served by audiobooks endpoint, not proxied)
        if (coverId && coverId.startsWith("/audiobooks/")) {
            const url = `${baseUrl}/api${coverId}`;
            if (token) {
                return `${url}?token=${encodeURIComponent(token)}`;
            }
            return url;
        }

        // Check if this is a podcast cover path (served by podcasts endpoint, not proxied)
        if (coverId && coverId.startsWith("/podcasts/")) {
            const url = `${baseUrl}/api${coverId}`;
            if (token) {
                return `${url}?token=${encodeURIComponent(token)}`;
            }
            return url;
        }

        // Check if coverId is an external URL (needs to be proxied)
        // Also handle native: paths which need URL encoding
        if (
            coverId &&
            (coverId.startsWith("http://") ||
                coverId.startsWith("https://") ||
                coverId.startsWith("native:"))
        ) {
            // Pass as query parameter to avoid URL encoding issues
            const params = new URLSearchParams({ url: coverId });
            if (size) params.append("size", size.toString());
            if (token) params.append("token", token);
            return `${baseUrl}/api/library/cover-art?${params.toString()}`;
        }

        // Otherwise use as path parameter (cover ID - typically a hash)
        const params = new URLSearchParams();
        if (size) params.append("size", size.toString());
        if (token) params.append("token", token);
        const queryString = params.toString();
        return `${baseUrl}/api/library/cover-art/${encodeURIComponent(coverId)}${
            queryString ? "?" + queryString : ""
        }`;
    }

    // Recommendations
    async getRecommendationsForYou(limit = 10) {
        return this.request<{ artists: ApiData[] }>(
            `/recommendations/for-you?limit=${limit}`
        );
    }

    async getSimilarArtists(seedArtistId: string, limit = 20) {
        return this.request<{ recommendations: ApiData[] }>(
            `/recommendations?seedArtistId=${seedArtistId}&limit=${limit}`
        );
    }

    async getSimilarAlbums(seedAlbumId: string, limit = 20) {
        return this.request<{ recommendations: ApiData[] }>(
            `/recommendations/albums?seedAlbumId=${seedAlbumId}&limit=${limit}`
        );
    }

    // Playlists
    async getPlaylists() {
        return this.request<ApiData[]>("/playlists");
    }

    async getPlaylist(id: string) {
        return this.request<ApiData>(`/playlists/${id}`);
    }

    async createPlaylist(name: string, isPublic = false) {
        return this.request<ApiData>("/playlists", {
            method: "POST",
            body: JSON.stringify({ name, isPublic }),
        });
    }

    async updatePlaylist(id: string, name: string, isPublic = false) {
        return this.request<ApiData>(`/playlists/${id}`, {
            method: "PUT",
            body: JSON.stringify({ name, isPublic }),
        });
    }

    async deletePlaylist(id: string) {
        return this.request<void>(`/playlists/${id}`, {
            method: "DELETE",
        });
    }

    async addTrackToPlaylist(playlistId: string, trackId: string) {
        return this.request<ApiData>(`/playlists/${playlistId}/items`, {
            method: "POST",
            body: JSON.stringify({ trackId }),
        });
    }

    async removeTrackFromPlaylist(playlistId: string, trackId: string) {
        return this.request<void>(`/playlists/${playlistId}/items/${trackId}`, {
            method: "DELETE",
        });
    }

    async hidePlaylist(playlistId: string) {
        return this.request<{ message: string; isHidden: boolean }>(
            `/playlists/${playlistId}/hide`,
            { method: "POST" }
        );
    }

    async unhidePlaylist(playlistId: string) {
        return this.request<{ message: string; isHidden: boolean }>(
            `/playlists/${playlistId}/hide`,
            { method: "DELETE" }
        );
    }

    async retryPendingTrack(playlistId: string, pendingTrackId: string) {
        return this.request<{
            success: boolean;
            message: string;
            error?: string;
            filePath?: string;
        }>(`/playlists/${playlistId}/pending/${pendingTrackId}/retry`, {
            method: "POST",
        });
    }

    async retryAllPendingTracks(playlistId: string) {
        return this.request<{
            success: boolean;
            queued: number;
            message: string;
        }>(`/playlists/${playlistId}/pending/retry-all`, {
            method: "POST",
        });
    }

    async removePendingTrack(playlistId: string, pendingTrackId: string) {
        return this.request<{ message: string }>(
            `/playlists/${playlistId}/pending/${pendingTrackId}`,
            { method: "DELETE" }
        );
    }

    async getFreshPreviewUrl(playlistId: string, pendingTrackId: string) {
        return this.request<{ previewUrl: string }>(
            `/playlists/${playlistId}/pending/${pendingTrackId}/preview`
        );
    }

    // Settings
    async getSettings() {
        return this.request<ApiData>("/settings");
    }

    async updateSettings(settings: ApiData) {
        return this.request<ApiData>("/settings", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    // System Features
    async getFeatures(): Promise<{ musicCNN: boolean; vibeEmbeddings: boolean }> {
        return this.request<{ musicCNN: boolean; vibeEmbeddings: boolean }>(
            "/system/features"
        );
    }

    // System Settings
    async getSystemSettings() {
        return this.request<ApiData>("/system-settings");
    }

    async updateSystemSettings(settings: ApiData) {
        return this.request<ApiData>("/system-settings", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    async clearAllCaches() {
        return this.request<ApiData>("/system-settings/clear-caches", {
            method: "POST",
        });
    }

    async cleanupStaleJobs() {
        return this.request<{
            success: boolean;
            cleaned: {
                discoveryBatches: { cleaned: number; ids: string[] };
                downloadJobs: { cleaned: number; ids: string[] };
                spotifyImportJobs: { cleaned: number; ids: string[] };
                bullQueues: { cleaned: number; queues: string[] };
            };
            totalCleaned: number;
        }>("/settings/cleanup-stale-jobs", {
            method: "POST",
        });
    }

    // System Settings Tests
    async testLidarr(url: string, apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-lidarr", {
            method: "POST",
            body: JSON.stringify({ url, apiKey }),
        });
    }

    async testLastfm(apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-lastfm", {
            method: "POST",
            body: JSON.stringify({ lastfmApiKey: apiKey }),
        });
    }

    async testOpenai(apiKey: string, model: string) {
        return this.request<ServiceTestResult>("/system-settings/test-openai", {
            method: "POST",
            body: JSON.stringify({ apiKey, model }),
        });
    }

    async testFanart(apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-fanart", {
            method: "POST",
            body: JSON.stringify({ fanartApiKey: apiKey }),
        });
    }

    async testAudiobookshelf(url: string, apiKey: string) {
        return this.request<ServiceTestResult>("/system-settings/test-audiobookshelf", {
            method: "POST",
            body: JSON.stringify({ url, apiKey }),
        });
    }

    async testSoulseek(username: string, password: string) {
        return this.request<ServiceTestResult>("/system-settings/test-soulseek", {
            method: "POST",
            body: JSON.stringify({ username, password }),
        });
    }

    async testSpotify(clientId: string, clientSecret: string) {
        return this.request<ServiceTestResult>("/system-settings/test-spotify", {
            method: "POST",
            body: JSON.stringify({ clientId, clientSecret }),
        });
    }

    // Downloads (Lidarr)
    async downloadAlbum(
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
        downloadType: "library" | "discovery" = "library"
    ) {
        return this.request<ApiData>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "album",
                subject: `${artistName} - ${albumTitle}`,
                mbid: rgMbid,
                artistName,
                albumTitle,
                downloadType,
            }),
        });
    }

    async downloadArtist(
        artistName: string,
        mbid: string,
        downloadType: "library" | "discovery" = "library"
    ) {
        return this.request<ApiData>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "artist",
                subject: artistName,
                mbid,
                downloadType,
            }),
        });
    }

    async deleteDownload(id: string) {
        return this.request<{ success: boolean }>(`/downloads/${id}`, {
            method: "DELETE",
        });
    }

    // Discover Weekly
    async generateDiscoverWeekly() {
        return this.request<{ message: string; jobId: string }>(
            "/discover/generate",
            {
                method: "POST",
            }
        );
    }

    async getCurrentDiscoverWeekly() {
        return this.request<{
            weekStart: string;
            weekEnd: string;
            tracks: ApiData[];
            unavailable: ApiData[];
            totalCount: number;
            unavailableCount: number;
        }>("/discover/current");
    }

    async getDiscoverBatchStatus() {
        return this.request<{
            active: boolean;
            status: "downloading" | "scanning" | null;
            batchId?: string;
            progress?: number;
            completed?: number;
            failed?: number;
            total?: number;
        }>("/discover/batch-status");
    }

    async cancelDiscoverBatch() {
        return this.request<{
            success: boolean;
            message: string;
            batchId?: string;
        }>("/discover/batch", {
            method: "DELETE",
        });
    }

    async retryUnavailableAlbums() {
        return this.request<{
            success: boolean;
            queued: number;
            batchId?: string;
            message: string;
        }>("/discover/retry-unavailable", {
            method: "POST",
        });
    }

    async likeDiscoverAlbum(albumId: string) {
        return this.request<{ success: boolean }>("/discover/like", {
            method: "POST",
            body: JSON.stringify({ albumId }),
        });
    }

    async unlikeDiscoverAlbum(albumId: string) {
        return this.request<{ success: boolean }>("/discover/unlike", {
            method: "DELETE",
            body: JSON.stringify({ albumId }),
        });
    }

    async getDiscoverConfig() {
        return this.request<{
            id: string;
            userId: string;
            playlistSize: number;
            enabled: boolean;
            lastGeneratedAt: string | null;
        }>("/discover/config");
    }

    async updateDiscoverConfig(config: {
        playlistSize?: number;
        enabled?: boolean;
    }) {
        return this.request<{
            id: string;
            userId: string;
            playlistSize: number;
            enabled: boolean;
            lastGeneratedAt: string | null;
        }>("/discover/config", {
            method: "PATCH",
            body: JSON.stringify(config),
        });
    }

    async clearDiscoverPlaylist() {
        return this.request<{
            success: boolean;
            message: string;
            likedMoved: number;
            activeDeleted: number;
        }>("/discover/clear", {
            method: "DELETE",
        });
    }

    // Artists (Discovery)
    async getArtistDiscovery(nameOrMbid: string) {
        return this.request<ApiData>(
            `/artists/discover/${encodeURIComponent(nameOrMbid)}`
        );
    }

    async getAlbumDiscovery(rgMbid: string) {
        return this.request<ApiData>(
            `/artists/album/${encodeURIComponent(rgMbid)}`
        );
    }

    async getTrackPreview(artistName: string, trackTitle: string) {
        return this.request<{ previewUrl: string }>(
            `/artists/preview/${encodeURIComponent(
                artistName
            )}/${encodeURIComponent(trackTitle)}`
        );
    }

    // Audiobooks
    async getAudiobooks() {
        return this.request<ApiData[]>("/audiobooks");
    }

    async getAudiobook(id: string) {
        return this.request<ApiData>(`/audiobooks/${id}`);
    }

    async getAudiobookSeries(seriesName: string) {
        return this.request<ApiData[]>(
            `/audiobooks/series/${encodeURIComponent(seriesName)}`
        );
    }

    getAudiobookStreamUrl(id: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/audiobooks/${id}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    async updateAudiobookProgress(
        id: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.request<ApiData>(`/audiobooks/${id}/progress`, {
            method: "POST",
            body: JSON.stringify({ currentTime, duration, isFinished }),
        });
    }

    async deleteAudiobookProgress(id: string) {
        return this.request<ApiData>(`/audiobooks/${id}/progress`, {
            method: "DELETE",
        });
    }

    // Podcasts
    async getPodcasts() {
        return this.request<ApiData[]>("/podcasts");
    }

    async getPodcast(id: string) {
        return this.request<ApiData>(`/podcasts/${id}`, { silent404: true });
    }

    async previewPodcast(itunesId: string) {
        return this.request<ApiData>(`/podcasts/preview/${itunesId}`);
    }

    getPodcastEpisodeStreamUrl(podcastId: string, episodeId: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/podcasts/${podcastId}/episodes/${episodeId}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    /**
     * Check if a podcast episode is cached locally
     * Returns { cached: boolean, downloading: boolean, downloadProgress: number | null }
     */
    async getPodcastEpisodeCacheStatus(
        podcastId: string,
        episodeId: string
    ): Promise<{
        cached: boolean;
        downloading: boolean;
        downloadProgress: number | null;
    }> {
        return this.request<{
            cached: boolean;
            downloading: boolean;
            downloadProgress: number | null;
        }>(`/podcasts/${podcastId}/episodes/${episodeId}/cache-status`);
    }

    async updatePodcastEpisodeProgress(
        podcastId: string,
        episodeId: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.request<ApiData>(
            `/podcasts/${podcastId}/episodes/${episodeId}/progress`,
            {
                method: "POST",
                body: JSON.stringify({ currentTime, duration, isFinished }),
            }
        );
    }

    // Alias for compatibility with AudioElement
    async updatePodcastProgress(
        podcastId: string,
        episodeId: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.updatePodcastEpisodeProgress(
            podcastId,
            episodeId,
            currentTime,
            duration,
            isFinished
        );
    }

    async deletePodcastEpisodeProgress(podcastId: string, episodeId: string) {
        return this.request<ApiData>(
            `/podcasts/${podcastId}/episodes/${episodeId}/progress`,
            {
                method: "DELETE",
            }
        );
    }

    async getSimilarPodcasts(podcastId: string) {
        return this.request<ApiData[]>(`/podcasts/${podcastId}/similar`);
    }

    async getTopPodcasts(limit = 20, genreId?: number) {
        const params = new URLSearchParams({ limit: limit.toString() });
        if (genreId) params.append("genreId", genreId.toString());
        return this.request<ApiData[]>(
            `/podcasts/discover/top?${params.toString()}`
        );
    }

    async getPodcastsByGenre(genreIds: number[]) {
        return this.request<ApiData>(
            `/podcasts/discover/genres?genres=${genreIds.join(",")}`
        );
    }

    async getPodcastsByGenrePaginated(genreId: number, limit = 20, offset = 0) {
        return this.request<ApiData[]>(
            `/podcasts/discover/genre/${genreId}?limit=${limit}&offset=${offset}`
        );
    }

    async subscribePodcast(feedUrl: string, itunesId?: string) {
        return this.request<{ success: boolean; podcast?: ApiData }>("/podcasts/subscribe", {
            method: "POST",
            body: JSON.stringify({ feedUrl, itunesId }),
        });
    }

    async removePodcast(podcastId: string) {
        return this.request<{ success: boolean; message: string }>(
            `/podcasts/${podcastId}/unsubscribe`,
            {
                method: "DELETE",
            }
        );
    }

    // Playback State (cross-device sync)
    async getPlaybackState() {
        return this.request<ApiData>("/playback-state");
    }

    async savePlaybackState(state: {
        playbackType: string;
        trackId?: string;
        audiobookId?: string;
        podcastId?: string;
        queue?: ApiData[];
        currentIndex?: number;
        isShuffle?: boolean;
    }) {
        return this.request<ApiData>("/playback-state", {
            method: "POST",
            body: JSON.stringify(state),
        });
    }

    async clearPlaybackState() {
        return this.request<void>("/playback-state", {
            method: "DELETE",
        });
    }

    // Search
    async search(
        query: string,
        type:
            | "all"
            | "artists"
            | "albums"
            | "tracks"
            | "audiobooks"
            | "podcasts" = "all",
        limit: number = 20,
        signal?: AbortSignal
    ) {
        return this.request<ApiData>(
            `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
            { signal }
        );
    }

    async discoverSearch(
        query: string,
        type: "music" | "podcasts" | "all" = "music",
        limit: number = 20,
        signal?: AbortSignal
    ) {
        return this.request<{
            results: ApiData[];
            aliasInfo: { original: string; canonical: string; mbid?: string } | null;
        }>(
            `/search/discover?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
            { signal }
        );
    }

    async discoverSimilarArtists(
        artist: string,
        mbid: string = "",
        signal?: AbortSignal
    ) {
        return this.request<{ similarArtists: ApiData[] }>(
            `/search/discover/similar?artist=${encodeURIComponent(artist)}&mbid=${encodeURIComponent(mbid)}`,
            { signal }
        );
    }

    // Soulseek - P2P Music Search & Download
    async getSlskdStatus() {
        return this.request<{
            enabled: boolean;
            connected: boolean;
            username?: string;
            message?: string;
        }>("/soulseek/status");
    }

    async searchSoulseek(query: string) {
        return this.request<{ searchId: string; message: string }>(
            "/soulseek/search",
            {
                method: "POST",
                body: JSON.stringify({ query }),
            }
        );
    }

    async downloadFromSoulseek(
        username: string,
        filepath: string,
        filename?: string,
        size?: number,
        artist?: string,
        album?: string,
        title?: string
    ) {
        return this.request<{
            success: boolean;
            message: string;
            filename: string;
        }>("/soulseek/download", {
            method: "POST",
            body: JSON.stringify({
                username,
                filepath,
                filename,
                size,
                artist,
                album,
                title,
            }),
        });
    }

    // Programmatic Mixes
    async getMixes() {
        return this.request<ApiData[]>("/mixes");
    }

    async getMix(id: string) {
        return this.request<ApiData>(`/mixes/${id}`);
    }

    async refreshMixes() {
        return this.request<{ message: string; mixes: ApiData[] }>(
            "/mixes/refresh",
            {
                method: "POST",
            }
        );
    }

    async saveMixAsPlaylist(mixId: string, customName?: string) {
        return this.request<{ id: string; name: string; trackCount: number }>(
            `/mixes/${mixId}/save`,
            {
                method: "POST",
                body: customName
                    ? JSON.stringify({ name: customName })
                    : undefined,
            }
        );
    }

    // Mood Bucket System (simplified, pre-computed)
    async getMoodBucketPresets() {
        return this.request<MoodBucketPreset[]>("/mixes/mood/buckets/presets");
    }

    async getMoodBucketMix(mood: MoodType) {
        return this.request<MoodBucketMix>(`/mixes/mood/buckets/${mood}`);
    }

    async saveMoodBucketMix(mood: MoodType) {
        return this.request<{
            success: boolean;
            mix: MoodBucketMix & { generatedAt: string };
        }>(
            `/mixes/mood/buckets/${mood}/save`,
            { method: "POST" }
        );
    }

    // Enrichment
    async syncLibraryEnrichment() {
        return this.request<{
            message: string;
            description: string;
            result: {
                artists: number;
                tracks: number;
                audioQueued: number;
            };
        }>("/enrichment/sync", {
            method: "POST",
        });
    }

    async getEnrichmentProgress() {
        return this.request<{
            artists: {
                total: number;
                completed: number;
                pending: number;
                failed: number;
                progress: number;
            };
            trackTags: {
                total: number;
                enriched: number;
                pending: number;
                progress: number;
            };
            audioAnalysis: {
                total: number;
                completed: number;
                pending: number;
                processing: number;
                failed: number;
                progress: number;
                isBackground: boolean;
            };
            clapEmbeddings: {
                total: number;
                completed: number;
                pending: number;
                processing: number;
                failed: number;
                progress: number;
                isBackground: boolean;
            };
            coreComplete: boolean;
            isFullyComplete: boolean;
        }>("/enrichment/progress");
    }

    async triggerFullEnrichment() {
        return this.request<{ message: string; description: string }>(
            "/enrichment/full",
            { method: "POST" }
        );
    }

    async resetArtistsOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-artists", { method: "POST" });
    }

    async resetMoodTagsOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-mood-tags", { method: "POST" });
    }

    async resetAudioAnalysisOnly() {
        return this.request<{
            message: string;
            description: string;
            count: number;
        }>("/enrichment/reset-audio-analysis", { method: "POST" });
    }

    async retryFailedAnalysis() {
        return this.request<{ message: string; reset: number }>("/analysis/retry-failed", {
            method: "POST",
        });
    }

    async updateArtistMetadata(
        artistId: string,
        data: {
            name?: string;
            bio?: string;
            genres?: string[];
            mbid?: string;
            heroUrl?: string;
        }
    ) {
        return this.request<ApiData>(`/enrichment/artists/${artistId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateAlbumMetadata(
        albumId: string,
        data: {
            title?: string;
            year?: number;
            genres?: string[];
            rgMbid?: string;
            coverUrl?: string;
        }
    ) {
        return this.request<ApiData>(`/enrichment/albums/${albumId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateTrackMetadata(trackId: string, data: ApiData) {
        // Placeholder - not implemented yet
        return this.request<ApiData>(`/library/tracks/${trackId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async resetArtistMetadata(artistId: string) {
        return this.request<{ message: string; artist: ApiData }>(
            `/enrichment/artists/${artistId}/reset`,
            { method: "POST" }
        );
    }

    async resetAlbumMetadata(albumId: string) {
        return this.request<{ message: string; album: ApiData }>(
            `/enrichment/albums/${albumId}/reset`,
            { method: "POST" }
        );
    }

    async resetTrackMetadata(trackId: string) {
        return this.request<{ message: string; track: ApiData }>(
            `/enrichment/tracks/${trackId}/reset`,
            { method: "POST" }
        );
    }

    // Homepage
    async getPopularArtists(limit = 20) {
        return this.request<{ artists: ApiData[] }>(
            `/discover/popular-artists?limit=${limit}`
        );
    }

    // API Keys Management
    async createApiKey(deviceName: string): Promise<{
        apiKey: string;
        name: string;
        createdAt: string;
        message: string;
    }> {
        return this.post("/api-keys", { deviceName });
    }

    async listApiKeys(): Promise<{
        apiKeys: Array<{
            id: string;
            name: string;
            createdAt: string;
            lastUsed: string | null;
        }>;
    }> {
        return this.get("/api-keys");
    }

    async revokeApiKey(id: string): Promise<{ message: string }> {
        return this.delete(`/api-keys/${id}`);
    }

    async getNotifications(): Promise<
        Array<{
            id: string;
            type: string;
            title: string;
            message: string | null;
            metadata: ApiData | null;
            read: boolean;
            cleared: boolean;
            createdAt: string;
        }>
    > {
        return this.get("/notifications");
    }

    async getUnreadNotificationCount(): Promise<{ count: number }> {
        return this.get("/notifications/unread-count");
    }

    async markNotificationAsRead(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/${id}/read`);
    }

    async markAllNotificationsAsRead(): Promise<{ success: boolean }> {
        return this.post("/notifications/read-all");
    }

    async clearNotification(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/${id}/clear`);
    }

    async clearAllNotifications(): Promise<{ success: boolean }> {
        return this.post("/notifications/clear-all");
    }

    // Download Activity
    async getActiveDownloads(): Promise<
        Array<{
            id: string;
            subject: string;
            type: string;
            status: string;
            createdAt: string;
            error?: string;
        }>
    > {
        return this.get("/notifications/downloads/active");
    }

    async getDownloadHistory(): Promise<
        Array<{
            id: string;
            subject: string;
            type: string;
            status: string;
            error?: string;
            createdAt: string;
            completedAt?: string;
        }>
    > {
        return this.get("/notifications/downloads/history");
    }

    async clearDownloadFromHistory(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/downloads/${id}/clear`);
    }

    async clearAllDownloadHistory(): Promise<{ success: boolean }> {
        return this.post("/notifications/downloads/clear-all");
    }

    // Vibe (CLAP Similarity) API
    async getVibeSimilarTracks(trackId: string, limit = 20) {
        return this.request<{
            sourceTrackId: string;
            tracks: Array<{
                id: string;
                title: string;
                duration: number;
                trackNo: number;
                distance: number;
                album: {
                    id: string;
                    title: string;
                    coverUrl: string | null;
                };
                artist: {
                    id: string;
                    name: string;
                };
            }>;
        }>(`/vibe/similar/${trackId}?limit=${limit}`);
    }

    async vibeSearch(query: string, limit = 20) {
        return this.request<{
            query: string;
            tracks: Array<{
                id: string;
                title: string;
                duration: number;
                trackNo: number;
                distance: number;
                similarity: number;
                album: {
                    id: string;
                    title: string;
                    coverUrl: string | null;
                };
                artist: {
                    id: string;
                    name: string;
                };
            }>;
            minSimilarity: number;
            totalAboveThreshold: number;
            debug?: {
                matchedTerms: string[];
                genreConfidence: number;
                featureWeight: number;
            };
        }>("/vibe/search", {
            method: "POST",
            body: JSON.stringify({ query, limit }),
        });
    }

    async getVibeStatus() {
        return this.request<{
            totalTracks: number;
            embeddedTracks: number;
            progress: number;
            isComplete: boolean;
        }>("/vibe/status");
    }

    async getTrackAnalysis(trackId: string) {
        return this.request<{
            id: string;
            title: string;
            analysisStatus: string;
            analysisError: string | null;
            analyzedAt: string | null;
            analysisVersion: string | null;
            analysisMode: string | null;
            bpm: number | null;
            beatsCount: number | null;
            key: string | null;
            keyScale: string | null;
            keyStrength: number | null;
            energy: number | null;
            loudness: number | null;
            dynamicRange: number | null;
            danceability: number | null;
            valence: number | null;
            arousal: number | null;
            instrumentalness: number | null;
            acousticness: number | null;
            speechiness: number | null;
            // MusiCNN mood predictions
            moodHappy: number | null;
            moodSad: number | null;
            moodRelaxed: number | null;
            moodAggressive: number | null;
            moodParty: number | null;
            moodAcoustic: number | null;
            moodElectronic: number | null;
            moodTags: string[] | null;
            essentiaGenres: string[] | null;
            lastfmTags: string[] | null;
        }>(`/analysis/track/${trackId}`);
    }

    async retryFailedDownload(
        id: string
    ): Promise<{ success: boolean; newJobId?: string }> {
        return this.post(`/notifications/downloads/${id}/retry`);
    }
}

// Create a singleton instance without passing baseUrl - it will be determined dynamically
export const api = new ApiClient();
