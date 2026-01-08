const AUTH_TOKEN_KEY = "auth_token";

// Mood Mix Types (Legacy - for old presets endpoint)
export interface MoodPreset {
    id: string;
    name: string;
    color: string;
    params: MoodMixParams;
}

export interface MoodMixParams {
    // Basic audio features
    valence?: { min?: number; max?: number };
    energy?: { min?: number; max?: number };
    danceability?: { min?: number; max?: number };
    acousticness?: { min?: number; max?: number };
    instrumentalness?: { min?: number; max?: number };
    arousal?: { min?: number; max?: number };
    bpm?: { min?: number; max?: number };
    keyScale?: "major" | "minor";
    // ML mood predictions (require Enhanced mode analysis)
    moodHappy?: { min?: number; max?: number };
    moodSad?: { min?: number; max?: number };
    moodRelaxed?: { min?: number; max?: number };
    moodAggressive?: { min?: number; max?: number };
    moodParty?: { min?: number; max?: number };
    moodAcoustic?: { min?: number; max?: number };
    moodElectronic?: { min?: number; max?: number };
    limit?: number;
}

// New Mood Bucket Types (simplified mood system)
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
    tracks?: any[];
}

export interface SavedMoodMixResponse {
    success: boolean;
    mix: MoodBucketMix & { generatedAt: string };
}

// Dynamically determine API URL based on configuration
const getApiBaseUrl = () => {
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

    // Refresh the base URL from configuration
    refreshBaseUrl(): void {
        this.baseUrl = "";
    }

    // Store JWT token
    setToken(token: string) {
        this.token = token;
        if (typeof window !== "undefined") {
            localStorage.setItem(AUTH_TOKEN_KEY, token);
        }
    }

    // Clear JWT token
    clearToken() {
        this.token = null;
        if (typeof window !== "undefined") {
            localStorage.removeItem(AUTH_TOKEN_KEY);
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
     * Make an authenticated API request
     * Public method for components that need custom API calls
     */
    async request<T>(
        endpoint: string,
        options: RequestInit & { silent404?: boolean } = {}
    ): Promise<T> {
        const { silent404, ...fetchOptions } = options;
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
            const error = await response.json().catch(() => ({
                error: response.statusText,
            }));

            // Only log non-404 errors (404s are often expected)
            if (!(silent404 && response.status === 404)) {
                console.error(`[API] Request failed: ${url}`, error);
            }

            if (response.status === 401) {
                const err = new Error("Not authenticated");
                (err as any).status = response.status;
                (err as any).data = error;
                throw err;
            }

            const err = new Error(error.error || "An error occurred");
            (err as any).status = response.status;
            (err as any).data = error;
            throw err;
        }

        const data = await response.json();
        return data;
    }

    // Generic POST method for convenience
    async post<T = any>(endpoint: string, data?: any): Promise<T> {
        return this.request<T>(endpoint, {
            method: "POST",
            body: data ? JSON.stringify(data) : undefined,
        });
    }

    // Generic GET method for convenience
    async get<T = any>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "GET",
        });
    }

    // Generic DELETE method for convenience
    async delete<T = any>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "DELETE",
        });
    }

    // Auth
    async login(username: string, password: string, token?: string) {
        const data = await this.request<{
            token?: string;
            user?: {
                id: string;
                username: string;
                role: string;
            };
            id?: string;
            username?: string;
            role?: string;
            requires2FA?: boolean;
        }>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password, token }),
        });

        // If login returned a JWT token, store it
        if (data.token) {
            this.setToken(data.token);
        }

        // Return user data in consistent format
        if (data.user) {
            return data.user;
        }
        return data as any;
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
    }) {
        return this.request<{
            artists: any[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/artists?${new URLSearchParams(params as any).toString()}`);
    }

    async getRecentlyListened(limit = 10) {
        return this.request<{ items: any[] }>(
            `/library/recently-listened?limit=${limit}`
        );
    }

    async getRecentlyAdded(limit = 10) {
        return this.request<{ artists: any[] }>(
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
            result?: any;
        }>(`/library/scan/status/${jobId}`);
    }

    async organizeLibrary() {
        return this.request<{ message: string }>("/library/organize", {
            method: "POST",
        });
    }

    async getArtist(id: string) {
        return this.request<any>(`/library/artists/${id}`);
    }

    async getAlbums(params?: {
        artistId?: string;
        limit?: number;
        offset?: number;
        filter?: "owned" | "discovery" | "all";
    }) {
        return this.request<{
            albums: any[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/albums?${new URLSearchParams(params as any).toString()}`);
    }

    async getAlbum(id: string) {
        return this.request<any>(`/library/albums/${id}`);
    }

    async getTracks(params?: {
        albumId?: string;
        limit?: number;
        offset?: number;
    }) {
        return this.request<{
            tracks: any[];
            total: number;
            offset: number;
            limit: number;
        }>(`/library/tracks?${new URLSearchParams(params as any).toString()}`);
    }

    async getShuffledTracks(limit?: number) {
        const params = limit ? `?limit=${limit}` : "";
        return this.request<{
            tracks: any[];
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
        return this.request<any>(`/library/tracks/${id}`);
    }

    async getRadioTracks(type: string, value?: string, limit = 50) {
        const params = new URLSearchParams({ type, limit: String(limit) });
        if (value) params.append("value", value);
        return this.request<{ tracks: any[] }>(
            `/library/radio?${params.toString()}`
        );
    }

    // Streaming
    getStreamUrl(trackId: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/library/tracks/${trackId}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        if (this.token) {
            return `${baseUrl}?token=${encodeURIComponent(this.token)}`;
        }
        return baseUrl;
    }

    getCoverArtUrl(coverId: string, size?: number): string {
        const baseUrl = this.getBaseUrl();

        // Check if this is an audiobook cover path (served by audiobooks endpoint, not proxied)
        if (coverId && coverId.startsWith("/audiobooks/")) {
            // Return direct path - audiobook covers are served from local disk
            // Add token for cross-origin requests (canvas color extraction needs this)
            const url = `${baseUrl}/api${coverId}`;
            if (this.token) {
                return `${url}?token=${encodeURIComponent(this.token)}`;
            }
            return url;
        }

        // Check if this is a podcast cover path (served by podcasts endpoint, not proxied)
        if (coverId && coverId.startsWith("/podcasts/")) {
            // Return direct path - podcast covers are served from local disk or redirected
            // Add token for cross-origin requests (canvas color extraction needs this)
            const url = `${baseUrl}/api${coverId}`;
            if (this.token) {
                return `${url}?token=${encodeURIComponent(this.token)}`;
            }
            return url;
        }

        // Check if coverId is an external URL (needs to be proxied)
        if (
            coverId &&
            (coverId.startsWith("http://") || coverId.startsWith("https://"))
        ) {
            // Pass as query parameter to avoid URL encoding issues
            const params = new URLSearchParams({ url: coverId });
            if (size) params.append("size", size.toString());
            // Add token for cross-origin requests (canvas color extraction needs this)
            if (this.token) params.append("token", this.token);
            return `${baseUrl}/api/library/cover-art?${params.toString()}`;
        }

        // Otherwise use as path parameter (cover ID - typically a hash)
        const params = new URLSearchParams();
        if (size) params.append("size", size.toString());
        // Add token for cross-origin requests (canvas color extraction needs this)
        if (this.token) params.append("token", this.token);
        const queryString = params.toString();
        return `${baseUrl}/api/library/cover-art/${coverId}${
            queryString ? "?" + queryString : ""
        }`;
    }

    // Recommendations
    async getRecommendationsForYou(limit = 10) {
        return this.request<{ artists: any[] }>(
            `/recommendations/for-you?limit=${limit}`
        );
    }

    async getSimilarArtists(seedArtistId: string, limit = 20) {
        return this.request<{ recommendations: any[] }>(
            `/recommendations?seedArtistId=${seedArtistId}&limit=${limit}`
        );
    }

    async getSimilarAlbums(seedAlbumId: string, limit = 20) {
        return this.request<{ recommendations: any[] }>(
            `/recommendations/albums?seedAlbumId=${seedAlbumId}&limit=${limit}`
        );
    }

    async getSimilarTracks(seedTrackId: string, limit = 20) {
        return this.request<{ recommendations: any[] }>(
            `/recommendations/tracks?seedTrackId=${seedTrackId}&limit=${limit}`
        );
    }

    // Playlists
    async getPlaylists() {
        return this.request<any[]>("/playlists");
    }

    async getPlaylist(id: string) {
        return this.request<any>(`/playlists/${id}`);
    }

    async createPlaylist(name: string, isPublic = false) {
        return this.request<any>("/playlists", {
            method: "POST",
            body: JSON.stringify({ name, isPublic }),
        });
    }

    async updatePlaylist(
        id: string,
        data: { name?: string; isPublic?: boolean }
    ) {
        return this.request<any>(`/playlists/${id}`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async deletePlaylist(id: string) {
        return this.request<void>(`/playlists/${id}`, {
            method: "DELETE",
        });
    }

    async addTrackToPlaylist(playlistId: string, trackId: string) {
        return this.request<any>(`/playlists/${playlistId}/items`, {
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

    // Playback tracking
    async trackPlayback(trackId: string, progress?: number) {
        return this.request<void>("/playback/track", {
            method: "POST",
            body: JSON.stringify({ trackId, progress }),
        });
    }

    // Play tracking
    async logPlay(trackId: string) {
        return this.request<any>("/plays", {
            method: "POST",
            body: JSON.stringify({ trackId }),
        });
    }

    async getRecentPlays(limit = 50) {
        return this.request<any[]>(`/plays?limit=${limit}`);
    }

    // Settings
    async getSettings() {
        return this.request<any>("/settings");
    }

    async updateSettings(settings: any) {
        return this.request<any>("/settings", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    // System Settings
    async getSystemSettings() {
        return this.request<any>("/system-settings");
    }

    async updateSystemSettings(settings: any) {
        return this.request<any>("/system-settings", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    async clearAllCaches() {
        return this.request<any>("/system-settings/clear-caches", {
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
        return this.request<any>("/system-settings/test-lidarr", {
            method: "POST",
            body: JSON.stringify({ url, apiKey }),
        });
    }

    async testNzbget(url: string, username: string, password: string) {
        return this.request<any>("/system-settings/test-nzbget", {
            method: "POST",
            body: JSON.stringify({ url, username, password }),
        });
    }

    async testQbittorrent(url: string, username: string, password: string) {
        return this.request<any>("/system-settings/test-qbittorrent", {
            method: "POST",
            body: JSON.stringify({ url, username, password }),
        });
    }

    async testLastfm(apiKey: string) {
        return this.request<any>("/system-settings/test-lastfm", {
            method: "POST",
            body: JSON.stringify({ lastfmApiKey: apiKey }),
        });
    }

    async testOpenai(apiKey: string, model: string) {
        return this.request<any>("/system-settings/test-openai", {
            method: "POST",
            body: JSON.stringify({ apiKey, model }),
        });
    }

    async testFanart(apiKey: string) {
        return this.request<any>("/system-settings/test-fanart", {
            method: "POST",
            body: JSON.stringify({ fanartApiKey: apiKey }),
        });
    }

    async testAudiobookshelf(url: string, apiKey: string) {
        return this.request<any>("/system-settings/test-audiobookshelf", {
            method: "POST",
            body: JSON.stringify({ url, apiKey }),
        });
    }

    async testSoulseek(username: string, password: string) {
        return this.request<any>("/system-settings/test-soulseek", {
            method: "POST",
            body: JSON.stringify({ username, password }),
        });
    }

    async testSpotify(clientId: string, clientSecret: string) {
        return this.request<any>("/system-settings/test-spotify", {
            method: "POST",
            body: JSON.stringify({ clientId, clientSecret }),
        });
    }

    async testListenNotes(apiKey: string) {
        return this.request<any>("/system-settings/test-listennotes", {
            method: "POST",
            body: JSON.stringify({ apiKey }),
        });
    }

    // Downloads (Lidarr)
    async downloadAlbum(
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
        downloadType: "library" | "discovery" = "library"
    ) {
        return this.request<any>("/downloads", {
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
        return this.request<any>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "artist",
                subject: artistName,
                mbid,
                downloadType,
            }),
        });
    }

    async getDownloadStatus(id: string) {
        return this.request<any>(`/downloads/${id}`);
    }

    async getDownloads(limit?: number, includeDiscovery: boolean = false) {
        const params = new URLSearchParams();
        if (limit) params.set("limit", String(limit));
        params.set("includeDiscovery", String(includeDiscovery));
        const query = params.toString() ? `?${params.toString()}` : "";
        return this.request<any[]>(`/downloads${query}`);
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

    async getDiscoverGenerationStatus(jobId: string) {
        return this.request<{
            status: string;
            progress: number;
            result?: {
                success: boolean;
                playlistName: string;
                songCount: number;
                error?: string;
            };
        }>(`/discover/generate/status/${jobId}`);
    }

    async getCurrentDiscoverWeekly() {
        return this.request<{
            weekStart: string;
            weekEnd: string;
            tracks: any[];
            unavailable: any[];
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

    // Discovery Exclusions
    async getDiscoverExclusions() {
        return this.request<{
            exclusions: Array<{
                id: string;
                albumMbid: string;
                artistName: string;
                albumTitle: string;
                lastSuggestedAt: string;
                expiresAt: string;
            }>;
            count: number;
        }>("/discover/exclusions");
    }

    async clearDiscoverExclusions() {
        return this.request<{
            success: boolean;
            message: string;
            clearedCount: number;
        }>("/discover/exclusions", {
            method: "DELETE",
        });
    }

    async removeDiscoverExclusion(id: string) {
        return this.request<{
            success: boolean;
            message: string;
        }>(`/discover/exclusions/${id}`, {
            method: "DELETE",
        });
    }

    // Artists (Discovery)
    async getArtistDiscovery(nameOrMbid: string) {
        return this.request<any>(
            `/artists/discover/${encodeURIComponent(nameOrMbid)}`
        );
    }

    async getAlbumDiscovery(rgMbid: string) {
        return this.request<any>(
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

    async testDeezer(apiKey?: string) {
        return this.request<any>("/system-settings/test-deezer", {
            method: "POST",
            body: JSON.stringify({ apiKey }),
        });
    }

    // Audiobooks
    async getAudiobooks() {
        return this.request<any[]>("/audiobooks");
    }

    async getAudiobook(id: string) {
        return this.request<any>(`/audiobooks/${id}`);
    }

    async getAudiobookSeries(seriesName: string) {
        return this.request<any[]>(
            `/audiobooks/series/${encodeURIComponent(seriesName)}`
        );
    }

    getAudiobookStreamUrl(id: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/audiobooks/${id}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        if (this.token) {
            return `${baseUrl}?token=${encodeURIComponent(this.token)}`;
        }
        return baseUrl;
    }

    async updateAudiobookProgress(
        id: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false
    ) {
        return this.request<any>(`/audiobooks/${id}/progress`, {
            method: "POST",
            body: JSON.stringify({ currentTime, duration, isFinished }),
        });
    }

    async deleteAudiobookProgress(id: string) {
        return this.request<any>(`/audiobooks/${id}/progress`, {
            method: "DELETE",
        });
    }

    async getContinueListening() {
        return this.request<any[]>("/audiobooks/continue-listening");
    }

    async searchAudiobooks(query: string) {
        return this.request<any[]>(
            `/audiobooks/search?q=${encodeURIComponent(query)}`
        );
    }

    // Podcasts
    async getPodcasts() {
        return this.request<any[]>("/podcasts");
    }

    async getPodcast(id: string) {
        return this.request<any>(`/podcasts/${id}`, { silent404: true });
    }

    async previewPodcast(itunesId: string) {
        return this.request<any>(`/podcasts/preview/${itunesId}`);
    }

    async getPodcastEpisode(podcastId: string, episodeId: string) {
        return this.request<any>(
            `/podcasts/${podcastId}/episodes/${episodeId}`
        );
    }

    getPodcastEpisodeStreamUrl(podcastId: string, episodeId: string): string {
        const baseUrl = `${this.getBaseUrl()}/api/podcasts/${podcastId}/episodes/${episodeId}/stream`;
        // For audio element requests, cookies may not be sent cross-origin in development
        // Add token as query param for authentication (supported by requireAuthOrToken)
        if (this.token) {
            return `${baseUrl}?token=${encodeURIComponent(this.token)}`;
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
        return this.request<any>(
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
        return this.request<any>(
            `/podcasts/${podcastId}/episodes/${episodeId}/progress`,
            {
                method: "DELETE",
            }
        );
    }

    async getSimilarPodcasts(podcastId: string) {
        return this.request<any[]>(`/podcasts/${podcastId}/similar`);
    }

    async getTopPodcasts(limit = 20, genreId?: number) {
        const params = new URLSearchParams({ limit: limit.toString() });
        if (genreId) params.append("genreId", genreId.toString());
        return this.request<any[]>(
            `/podcasts/discover/top?${params.toString()}`
        );
    }

    async getPodcastsByGenre(genreIds: number[]) {
        return this.request<any>(
            `/podcasts/discover/genres?genres=${genreIds.join(",")}`
        );
    }

    async getPodcastsByGenrePaginated(genreId: number, limit = 20, offset = 0) {
        return this.request<any[]>(
            `/podcasts/discover/genre/${genreId}?limit=${limit}&offset=${offset}`
        );
    }

    async subscribePodcast(feedUrl: string, itunesId?: string) {
        return this.request<any>("/podcasts/subscribe", {
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
        return this.request<any>("/playback-state");
    }

    async savePlaybackState(state: {
        playbackType: string;
        trackId?: string;
        audiobookId?: string;
        podcastId?: string;
        queue?: any[];
        currentIndex?: number;
        isShuffle?: boolean;
    }) {
        return this.request<any>("/playback-state", {
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
        limit: number = 20
    ) {
        return this.request<any>(
            `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`
        );
    }

    async discoverSearch(
        query: string,
        type: "music" | "podcasts" | "all" = "music",
        limit: number = 20
    ) {
        return this.request<any>(
            `/search/discover?q=${encodeURIComponent(
                query
            )}&type=${type}&limit=${limit}`
        );
    }

    // Slskd (Soulseek) - P2P Music Search & Download
    async getSlskdStatus() {
        return this.request<{ connected: boolean; username?: string }>(
            "/slskd/status"
        );
    }

    async searchSoulseek(query: string) {
        return this.request<{ searchId: string; message: string }>(
            "/slskd/search",
            {
                method: "POST",
                body: JSON.stringify({ query }),
            }
        );
    }

    async getSoulseekResults(searchId: string) {
        return this.request<{ results: any[]; count: number }>(
            `/slskd/search/${searchId}`
        );
    }

    async downloadFromSoulseek(
        username: string,
        filepath: string,
        filename?: string,
        size?: number,
        artist?: string,
        album?: string
    ) {
        return this.request<{
            success: boolean;
            message: string;
            filename: string;
        }>("/slskd/download", {
            method: "POST",
            body: JSON.stringify({
                username,
                filepath,
                filename,
                size,
                artist,
                album,
            }),
        });
    }

    async getSlskdDownloads() {
        return this.request<{ downloads: any[]; count: number }>(
            "/slskd/downloads"
        );
    }

    // Programmatic Mixes
    async getMixes() {
        return this.request<any[]>("/mixes");
    }

    async getMix(id: string) {
        return this.request<any>(`/mixes/${id}`);
    }

    async refreshMixes() {
        return this.request<{ message: string; mixes: any[] }>(
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

    // Mood on Demand (Legacy)
    async getMoodPresets() {
        return this.request<MoodPreset[]>("/mixes/mood/presets");
    }

    async generateMoodMix(params: MoodMixParams) {
        return this.request<any>("/mixes/mood", {
            method: "POST",
            body: JSON.stringify(params),
        });
    }

    // New Mood Bucket System (simplified, pre-computed)
    async getMoodBucketPresets() {
        return this.request<MoodBucketPreset[]>("/mixes/mood/buckets/presets");
    }

    async getMoodBucketMix(mood: MoodType) {
        return this.request<MoodBucketMix>(`/mixes/mood/buckets/${mood}`);
    }

    async saveMoodBucketMix(mood: MoodType) {
        return this.request<SavedMoodMixResponse>(
            `/mixes/mood/buckets/${mood}/save`,
            { method: "POST" }
        );
    }

    async backfillMoodBuckets() {
        return this.request<{
            success: boolean;
            processed: number;
            assigned: number;
        }>("/mixes/mood/buckets/backfill", { method: "POST" });
    }

    // Enrichment
    async getEnrichmentSettings() {
        return this.request<any>("/enrichment/settings");
    }

    async updateEnrichmentSettings(settings: any) {
        return this.request<any>("/enrichment/settings", {
            method: "PUT",
            body: JSON.stringify(settings),
        });
    }

    async enrichArtist(artistId: string) {
        return this.request<{
            success: boolean;
            confidence: number;
            data: any;
        }>(`/enrichment/artist/${artistId}`, {
            method: "POST",
        });
    }

    async enrichAlbum(albumId: string) {
        return this.request<{
            success: boolean;
            confidence: number;
            data: any;
        }>(`/enrichment/album/${albumId}`, {
            method: "POST",
        });
    }

    async startLibraryEnrichment() {
        return this.request<{ success: boolean; message: string }>(
            "/enrichment/start",
            {
                method: "POST",
            }
        );
    }

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
        return this.request<any>(`/enrichment/artists/${artistId}/metadata`, {
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
        return this.request<any>(`/enrichment/albums/${albumId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateTrackMetadata(trackId: string, data: any) {
        // Placeholder - not implemented yet
        return this.request<any>(`/library/tracks/${trackId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async resetArtistMetadata(artistId: string) {
        return this.request<{ message: string; artist: any }>(
            `/enrichment/artists/${artistId}/reset`,
            { method: "POST" }
        );
    }

    async resetAlbumMetadata(albumId: string) {
        return this.request<{ message: string; album: any }>(
            `/enrichment/albums/${albumId}/reset`,
            { method: "POST" }
        );
    }

    async resetTrackMetadata(trackId: string) {
        return this.request<{ message: string; track: any }>(
            `/enrichment/tracks/${trackId}/reset`,
            { method: "POST" }
        );
    }

    // Homepage
    async getHomepageGenres(limit = 4) {
        return this.request<any[]>(`/homepage/genres?limit=${limit}`);
    }

    async getHomepageTopPodcasts(limit = 6) {
        return this.request<any[]>(`/homepage/top-podcasts?limit=${limit}`);
    }

    async getPopularArtists(limit = 20) {
        return this.request<{ artists: any[] }>(
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

    // ============================================
    // Notifications & Activity Panel
    // ============================================

    async getNotifications(): Promise<
        Array<{
            id: string;
            type: string;
            title: string;
            message: string | null;
            metadata: any;
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

    async retryFailedDownload(
        id: string
    ): Promise<{ success: boolean; newJobId?: string }> {
        return this.post(`/notifications/downloads/${id}/retry`);
    }
}

// Create a singleton instance without passing baseUrl - it will be determined dynamically
export const api = new ApiClient();
