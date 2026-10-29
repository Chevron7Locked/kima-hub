import type { MapTrack } from "@/features/vibe/types";
import type { DiscoveryPodcast, ForYouRow, ListeningRow, PodcastCategory } from "@/features/podcast/types";
import type { Mix } from "@/features/home/types";
import { backendUrl } from "@/lib/backend-url";

const AUTH_TOKEN_KEY = "auth_token";
const REFRESH_TOKEN_KEY = "refresh_token";

// Mood Bucket Types (simplified mood system)
export type MoodType = "happy" | "sad" | "chill" | "aggressive" | "party";

/** The six enrichment steps a re-run can start from. */
export type EnrichmentRerunStep = "identification" | "artists" | "analysis" | "vectors" | "moods" | "similarity";

export interface MoodBucketPreset {
    id: MoodType;
    name: string;
    color: string;
    icon: string;
    trackCount: number;
    /** Tracks still waiting for audio analysis, so not yet sortable into moods. */
    pendingTracks?: number;
}

interface MoodBucketMix {
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

interface VibePathTrack {
    id: string;
    title: string;
    displayTitle?: string | null;
    duration: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

/** Similar-tracks answers share this shape; /vibe/similar and /vibe/alchemy send no trackNo. */
interface VibeTrack {
    id: string;
    title: string;
    displayTitle?: string | null;
    duration: number;
    trackNo?: number;
    distance: number;
    similarity: number;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
}

/**
 * The 1.11 release window's mood-mix answer (backend services/releases/moodMixes.ts).
 * "remove" clears a retired mix and does the same as "rebuild".
 */
export type MoodMixDecision = "rebuild" | "keep" | "remove";

interface UpdateStatus {
    enabled: boolean;
    current: string;
    latest: string | null;
    hasUpdate: boolean;
    lastCheckedAt: string | null;
}

export interface MoodMixReleaseState {
    /**
     * The user's saved mood mix; null when they have none or cleared it.
     * `retired`: saved under a mood 1.11 removed, so it can't be shown or kept.
     */
    mix: { id: string; name: string; mood: string; trackCount: number; retired: boolean } | null;
    /** "rebuild" means the mix was cleared, by Rebuild or Remove. */
    decision: "rebuild" | "keep" | null;
    /** The playlist this mix was already saved as, if any. */
    playlist: { id: string; name: string } | null;
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

/** A show from Apple's catalogue, as /search/discover?type=podcasts answers it (backend routes/search.ts). */
export interface PodcastShowResult {
    type: "podcast";
    id: number;
    name: string;
    artist?: string;
    description?: string;
    coverUrl?: string;
    feedUrl?: string;
    genres: string[];
    categoryIds: number[];
    trackCount?: number;
}

/** An episode of a followed show, as /search?type=episodes answers it (backend services/search.ts). */
export interface EpisodeSearchResult {
    id: string;
    title: string;
    description: string | null;
    podcastId: string;
    podcastTitle: string;
    publishedAt: string;
    duration: number;
    audioUrl: string;
}

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
    if (typeof window === "undefined") {
        return backendUrl;
    }

    // Explicit env var: used for reverse proxies where the API is on a different origin
    if (process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL;
    }

    // Default: relative URLs so Next.js rewrites proxy to the backend.
    // Works for any host port mapping (e.g. -p 9000:3030) because the browser
    // origin matches whatever port the user mapped -- no hardcoded port needed.
    return "";
};

type RefreshResult = "refreshed" | "rejected" | "network-error";

// Distinguishes a transient network outage during token refresh from a real
// 401 (session expired) so callers don't log the user out on a dropped
// connection.
export class NetworkError extends Error {
    name = "NetworkError";
}

// Leaving the page (a reload, a typed address) makes the browser cancel every open request, just after pagehide.
// Those cancellations are not failures: see the fetch in ApiClient.request. A page that comes back shows itself
// with pageshow, or, for a phone or installed app resumed from the background, by becoming visible again.
let leavingPage = false;
const isBack = (e: Event) => e.type === "pageshow" || document.visibilityState === "visible";
if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
        leavingPage = true;
    });
    const back = (e: Event) => {
        if (isBack(e)) leavingPage = false;
    };
    window.addEventListener("pageshow", back);
    document.addEventListener("visibilitychange", back);
}
const pageBack = () =>
    new Promise<void>((resume) => {
        const onEvent = (e: Event) => {
            if (!isBack(e)) return;
            window.removeEventListener("pageshow", onEvent);
            document.removeEventListener("visibilitychange", onEvent);
            resume();
        };
        window.addEventListener("pageshow", onEvent);
        document.addEventListener("visibilitychange", onEvent);
    });

// Enrichment engine contract (mirrors backend/src/services/enrichmentState).
interface EnrichmentState {
    status: "idle" | "running" | "paused" | "stopping" | "failed";
    startedAt?: string;
    pausedAt?: string;
    stoppedAt?: string;
    currentPhase: "artists" | "tracks" | "fingerprint" | "audio" | "podcasts" | "vibe" | "mood" | "similarity" | null;
    lastActivity: string;
    /** Set by the backend when status=running but nothing has moved for >15 min. */
    hung?: boolean;
    artists: {
        total: number;
        completed: number;
        failed: number;
    };
    tracks: {
        total: number;
        completed: number;
        failed: number;
    };
    audio: {
        total: number;
        completed: number;
        failed: number;
        processing: number;
    };
}

export interface EnrichmentFailure {
    id: string;
    /** track/audio/vibe/scan failures come from TrackStage records, artist ones from the failure ledger. */
    entityType: "artist" | "track" | "audio" | "vibe" | "scan";
    entityId: string;
    entityName: string | null;
    errorMessage: string | null;
    errorCode: string | null;
    retryCount: number;
    maxRetries: number;
    firstFailedAt: string;
    lastFailedAt: string;
    skipped: boolean;
    skippedAt: string | null;
    resolved: boolean;
    resolvedAt: string | null;
    metadata: Record<string, unknown> | null;
}

interface FailureCounts {
    artist: number;
    track: number;
    audio: number;
    vibe: number;
    /** Fingerprint-stage failures — TrackStage-backed, same as the rest. */
    scan: number;
    podcast: number;
    total: number;
}

interface ConcurrencyConfig {
    concurrency: number;
}

export interface AnalysisWorkersConfig {
    workers: number;
    cpuCores: number;
    recommended: number;
    description: string;
    /** Whether an analyzer is running, from the heartbeat it writes to Redis every 30s. */
    analyzerOnline?: boolean;
    /**
     * How many subscribers received the change. Redis reports this; zero means
     * the number was stored but nothing was listening.
     */
    delivered?: number;
}

export interface GpuRuntimeStatus {
    /** Whether the CUDA runtime exists for this host (linux/x86_64); false hides the switches everywhere. */
    supported: boolean;
    /** The switch for vibe embeddings (sound vectors). */
    enabled: boolean;
    /** The switch for audio analysis (MusiCNN); shares the same download. */
    analysis: boolean;
    analysisEffective: boolean;
    installed: boolean;
    installing: boolean;
    effective: boolean;
    /** The analyzer started with the runtime and its session did not get the GPU. */
    fellBack: boolean;
    analysisFellBack: boolean;
    /** The vibe embeddings analyzer, which downloads the runtime for both switches, is running. */
    installerUp: boolean;
    status: string;
    reason: string | null;
    detail: string | null;
    bytesDownloaded: number | null;
    pinned: string[];
    providerActive: boolean;
    analysisProviderActive: boolean;
    updatedAt: string | null;
}

/**
 * The browser's storage, when it exists. SSR never has it; some client
 * environments throw on access (sandboxed iframes). Callers keep working in
 * memory when it's absent. Reads the global, which is what a browser exposes.
 */
const authStorage = (): Storage | null => {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
        return null;
    }
};

class ApiClient {
    private token: string | null = null;
    private refreshPromise: Promise<RefreshResult> | null = null;
    private ensurePromise: Promise<"fresh" | RefreshResult> | null = null;

    constructor() {
        const storage = authStorage();
        if (storage) {
            this.token = storage.getItem(AUTH_TOKEN_KEY);
            // Note: Refresh token is loaded on-demand via getRefreshToken()
        }
    }

    /**
     * Get the current token (may be null)
     */
    getToken(): string | null {
        return this.token;
    }

    setToken(token: string, refreshToken?: string) {
        this.token = token;
        const storage = authStorage();
        if (storage) {
            storage.setItem(AUTH_TOKEN_KEY, token);
            if (refreshToken) {
                storage.setItem(REFRESH_TOKEN_KEY, refreshToken);
            }
        }
    }

    getRefreshToken(): string | null {
        const storage = authStorage();
        return storage ? storage.getItem(REFRESH_TOKEN_KEY) : null;
    }

    clearToken() {
        this.token = null;
        const storage = authStorage();
        if (storage) {
            storage.removeItem(AUTH_TOKEN_KEY);
            storage.removeItem(REFRESH_TOKEN_KEY);
        }
    }

    /**
     * Refresh the access token using the refresh token.
     * Deduplicates concurrent refresh calls -- all concurrent 401s share one refresh attempt.
     */
    private async refreshAccessToken(): Promise<RefreshResult> {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this._doRefresh();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * "fresh" when the token has over 60 minutes left (no request). Otherwise
     * refreshes: "rejected" clears tokens, "network-error" keeps them.
     * Concurrent calls share one request.
     */
    async ensureFreshToken(): Promise<"fresh" | RefreshResult> {
        if (this.ensurePromise) return this.ensurePromise;
        this.ensurePromise = this._doEnsureFreshToken();
        try {
            return await this.ensurePromise;
        } finally {
            this.ensurePromise = null;
        }
    }

    private async _doEnsureFreshToken(): Promise<"fresh" | RefreshResult> {
        const secondsLeft = this.tokenSecondsLeft();
        if (secondsLeft !== null && secondsLeft > 3600) return "fresh";

        if (this.refreshPromise) return (await this.refreshPromise);
        this.refreshPromise = this._doRefresh();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    /** Returns the Authorization header value for the current token, or null. */
    getAuthHeader(): string | null {
        const tok = this.getCurrentToken();
        return tok ? `Bearer ${tok}` : null;
    }

    /** Seconds until the access token expires; null when there is no token or it has no readable expiry. */
    private tokenSecondsLeft(): number | null {
        const tok = this.getCurrentToken();
        if (!tok) return null;
        try {
            const parts = tok.split(".");
            if (parts.length !== 3) return null;
            const payload = JSON.parse(
                atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
            ) as { exp?: number };
            return typeof payload.exp === "number" ? payload.exp - Date.now() / 1000 : null;
        } catch {
            return null;
        }
    }

    private tokenExpiresWithin60Min(): boolean {
        const secondsLeft = this.tokenSecondsLeft();
        return secondsLeft !== null && secondsLeft < 3600;
    }

    private async _doRefresh(): Promise<"refreshed" | "rejected" | "network-error"> {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) {
            return "rejected";
        }

        let response: Response;
        try {
            response = await fetch(
                `${getApiBaseUrl()}/api/auth/refresh`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refreshToken }),
                    credentials: "include",
                }
            );
        } catch (error) {
            // Network/fetch failure (TypeError, AbortError): keep tokens intact.
            // Clearing tokens on a transient network failure would log the user
            // out during a subway ride. A page being left cancels it: not a failure.
            if (!leavingPage) console.error("[API] Token refresh network error:", error);
            return "network-error";
        }

        if (!response.ok) {
            // Server explicitly rejected the refresh token -- session is invalid.
            this.clearToken();
            return "rejected";
        }

        let data: { token?: string; refreshToken?: string };
        try {
            data = await response.json();
        } catch (error) {
            // The answer was cut off on its way in (leaving the page, a dropped connection): as above.
            if (!leavingPage) console.error("[API] Token refresh network error:", error);
            return "network-error";
        }

        if (data.token) {
            this.setToken(data.token, data.refreshToken);
            return "refreshed";
        }

        this.clearToken();
        return "rejected";
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
            noTimeout?: boolean; // exempt streaming/blob/arrayBuffer from default timeout
        } = {}
    ): Promise<T> {
        const { silent404, _retryCount = 0, noTimeout, ...fetchOptions } = options;

        // Default 30s timeout for JSON API calls; streaming/blob/arrayBuffer exempt via noTimeout.
        // Server uses timeout=0 for streams — a client-side cap would kill legitimate long streams.
        const signal = noTimeout
            ? fetchOptions.signal
            : fetchOptions.signal
                ? AbortSignal.any([AbortSignal.timeout(30_000), fetchOptions.signal])
                : AbortSignal.timeout(30_000);

        const headers: HeadersInit = {
            "Content-Type": "application/json",
            ...fetchOptions.headers,
        };

        if (this.token) {
            (headers as Record<string, string>)[
                "Authorization"
            ] = `Bearer ${this.token}`;
        }

        // All API endpoints are prefixed with /api
        const url = `${getApiBaseUrl()}/api${endpoint}`;

        // Cancelled because the page is being left, whether before the answer or while its body was arriving:
        // nothing will read it, unless the page comes back (the back/forward cache, a resumed app). Then a read is
        // asked again; anything else reports the cancellation, as it may already have reached the server.
        const cancelledByLeaving = async (err: unknown): Promise<T> => {
            if (!leavingPage) throw err;
            await pageBack();
            if ((fetchOptions.method ?? "GET").toUpperCase() === "GET") return this.request<T>(endpoint, options);
            throw err;
        };

        let response: Response;
        try {
            response = await fetch(url, {
                ...fetchOptions,
                headers,
                credentials: "include",
                signal,
            });
        } catch (err) {
            return cancelledByLeaving(err);
        }

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

            // 401s are handled below (refresh, or a sign-in prompt); 404s can be expected.
            if (response.status !== 401 && !(silent404 && response.status === 404)) {
                console.error(`[API] Request failed: ${url}`, {
                    status: response.status,
                    statusText: response.statusText,
                    error,
                    headers: Object.fromEntries(response.headers.entries()),
                });
            }

            // Signing in checks credentials, not a session: its 401 is the server's answer
            // (wrong password, wrong code), never an expired session to refresh.
            const signingIn = endpoint === "/auth/login";

            // Handle 401 with token refresh (retry once)
            if (
                response.status === 401 &&
                _retryCount === 0 &&
                endpoint !== "/auth/refresh" &&
                !signingIn
            ) {
                const refreshResult = await this.refreshAccessToken();

                if (refreshResult === "refreshed") {
                    return this.request<T>(endpoint, {
                        ...options,
                        _retryCount: 1, // Prevent infinite loops
                    });
                }

                if (refreshResult === "network-error") {
                    // Transient outage -- tokens are left intact by _doRefresh.
                    // Do not throw "Not authenticated": that would look like a
                    // real session expiry and log the user out over a dropped
                    // connection.
                    throw new NetworkError("Token refresh failed: network error");
                }

                // "rejected" -- server invalidated the refresh token, a real
                // session expiry. Fall through to the 401 handling below.
            }

            if (response.status === 401) {
                const err = new Error(signingIn ? String(error.error || "Sign-in failed") : "Not authenticated");
                (err as ApiError).status = response.status;
                (err as ApiError).data = error;
                throw err;
            }

            const err = new Error(String(error.error || error.message || "An error occurred"));
            (err as ApiError).status = response.status;
            (err as ApiError).data = error;
            throw err;
        }

        try {
            return await response.json();
        } catch (err) {
            return cancelledByLeaving(err);
        }
    }

    async post<T = unknown>(endpoint: string, data?: unknown): Promise<T> {
        return this.request<T>(endpoint, {
            method: "POST",
            body: data ? JSON.stringify(data) : undefined,
        });
    }

    async get<T = unknown>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "GET",
        });
    }

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

    async logout() {
        await this.request<void>("/auth/logout", {
            method: "POST",
        });
        this.clearToken();
    }

    async getCurrentUser() {
        return this.request<{
            id: string;
            username: string;
            role: string;
            onboardingComplete?: boolean;
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
            result?: { tracksAdded: number; tracksUpdated: number; tracksMissing: number };
        }>(`/library/scan/status/${jobId}`);
    }

    async getArtist(id: string) {
        return this.request<ApiData>(`/library/artists/${encodeURIComponent(id)}`);
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
        return this.tokenizedUrl(`/api/library/tracks/${trackId}/stream`);
    }

    /** `<audio>` cannot send headers, so the access token rides in the query; a token near expiry is refreshed in the background. */
    private tokenizedUrl(path: string): string {
        const baseUrl = `${getApiBaseUrl()}${path}`;
        const token = this.getCurrentToken();
        if (this.tokenExpiresWithin60Min()) void this.ensureFreshToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
    }

    prewarmTrack(trackId: string): void {
        void this.request<{ ok: boolean }>(`/library/tracks/${trackId}/prewarm`, {
            method: "POST",
        }).catch(() => {});
    }

    /** The token, read from localStorage on first use when the singleton was created during SSR. */
    private getCurrentToken(): string | null {
        // If we already have a token, use it
        if (this.token) {
            return this.token;
        }
        // Try to load from storage if on client
        const storage = authStorage();
        if (storage) {
            const storedToken = storage.getItem(AUTH_TOKEN_KEY);
            if (storedToken) {
                this.token = storedToken;
                return storedToken;
            }
        }
        return null;
    }

    /** Cover art URL for an id, URL or path; the token lets a canvas read its pixels for colour extraction. */
    getCoverArtUrl(coverId: string, size?: number, includeToken = true): string {
        const baseUrl = getApiBaseUrl();
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

    async updatePlaylist(id: string, data: { name?: string; isPublic?: boolean }) {
        return this.request<ApiData>(`/playlists/${id}`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updatePlaylistOrder(id: string, reverseOrder: boolean) {
        return this.request<ApiData>(`/playlists/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ reverseOrder }),
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

    /** Adds many tracks in one request. */
    async addTracksToPlaylist(playlistId: string, trackIds: string[]) {
        return this.request<{
            added: number;
            duplicates: number;
            rejected: string[];
        }>(`/playlists/${playlistId}/items`, {
            method: "POST",
            body: JSON.stringify({ trackIds }),
        });
    }

    async removeTrackFromPlaylist(playlistId: string, trackId: string) {
        return this.request<void>(`/playlists/${playlistId}/items/${trackId}`, {
            method: "DELETE",
        });
    }

    async moveTrackInPlaylist(playlistId: string, itemId: string, afterItemId: string | null) {
        return this.request<{ success: boolean; rank: string }>(
            `/playlists/${playlistId}/items/${itemId}/move`,
            {
                method: "PATCH",
                body: JSON.stringify({ afterItemId }),
            }
        );
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

    getPendingTrackPreviewStreamUrl(
        playlistId: string,
        pendingTrackId: string
    ): string {
        const baseUrl = `${getApiBaseUrl()}/api/playlists/${encodeURIComponent(
            playlistId
        )}/pending/${encodeURIComponent(pendingTrackId)}/preview/stream`;
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
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
    async getFeatures(): Promise<{ musicCNN: boolean; vibeEmbeddings: boolean; audiobookshelfEnabled: boolean; liveReporting?: boolean }> {
        return this.request<{ musicCNN: boolean; vibeEmbeddings: boolean; audiobookshelfEnabled: boolean; liveReporting?: boolean }>(
            "/system/features"
        );
    }

    // System Settings
    async getPublicConfig(): Promise<{ publicUrl: string; canAcquire: boolean }> {
        return this.request<{ publicUrl: string; canAcquire: boolean }>("/system-settings/public-config");
    }

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

    /** Tests the backend being configured: slskd by its URL and key, or the Soulseek network by account. */
    async testSoulseek(settings: {
        mode: "p2p" | "slskd";
        username?: string;
        password?: string;
        slskdUrl?: string;
        slskdApiKey?: string;
    }) {
        return this.request<ServiceTestResult>("/system-settings/test-soulseek", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    }

    // Downloads (Lidarr)
    async downloadAlbum(
        artistName: string,
        albumTitle: string,
        rgMbid?: string
    ) {
        return this.request<ApiData>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "album",
                subject: `${artistName} - ${albumTitle}`,
                mbid: rgMbid,
                artistName,
                albumTitle,
            }),
        });
    }

    async downloadArtist(
        artistName: string,
        mbid: string
    ) {
        return this.request<ApiData>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "artist",
                subject: artistName,
                mbid,
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

    async getSSETicket(): Promise<string | null> {
        try {
            const res = await this.post<{ ticket: string }>("/events/ticket", {});
            return res.ticket;
        } catch {
            return null;
        }
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
            /** Albums the clear could not finish (Lidarr refused, a file could not be deleted); the server's alert names them. */
            lidarrFailed: { artistName: string; albumTitle: string; reason: string }[];
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

    getTrackPreviewStreamUrl(artistName: string, trackTitle: string): string {
        const baseUrl = `${getApiBaseUrl()}/api/artists/preview/${encodeURIComponent(
            artistName
        )}/${encodeURIComponent(trackTitle)}/stream`;
        const token = this.getCurrentToken();
        if (token) {
            return `${baseUrl}?token=${encodeURIComponent(token)}`;
        }
        return baseUrl;
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

    getAudiobookStreamUrl(id: string, trackIndex = 0): string {
        const baseUrl = `${getApiBaseUrl()}/api/audiobooks/${id}/stream`;
        const token = this.getCurrentToken();
        if (this.tokenExpiresWithin60Min()) void this.ensureFreshToken();
        const params = new URLSearchParams();
        if (token) params.set("token", token);
        if (trackIndex > 0) params.set("trackIndex", String(trackIndex));
        const qs = params.toString();
        return qs ? `${baseUrl}?${qs}` : baseUrl;
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
            // Sent as the page closes too (pagehide): kept alive, the browser finishes it instead of cancelling it.
            keepalive: true,
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

    async getPodcast(
        id: string,
        params?: { order?: "newest" | "oldest"; limit?: number; offset?: number }
    ) {
        const query = new URLSearchParams();
        if (params?.order) query.set("order", params.order);
        if (params?.limit) query.set("limit", String(params.limit));
        if (params?.offset) query.set("offset", String(params.offset));
        const suffix = query.size > 0 ? `?${query}` : "";
        return this.request<ApiData>(`/podcasts/${id}${suffix}`, {
            silent404: true,
        });
    }

    async previewPodcast(itunesId: string) {
        // Bound the preview so a slow or dead feed ends in an error, not an endless spinner. 25 s sits
        // above the backend's worst case (~18 s on the Deezer path: Deezer fetch, iTunes resolve, the
        // 8 s RSS bound), so an answerable feed is not aborted as a false timeout.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
            return await this.request<ApiData>(`/podcasts/preview/${itunesId}`, { signal: controller.signal });
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
                throw new Error("Podcast preview timed out. The feed may be slow or unreachable.");
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    getPodcastEpisodeStreamUrl(podcastId: string, episodeId: string): string {
        return this.tokenizedUrl(`/api/podcasts/${podcastId}/episodes/${episodeId}/stream`);
    }

    /** What plays after an episode: the show's next one by release date not yet finished; null at the show's end. */
    async getNextPodcastEpisode(podcastId: string, episodeId: string) {
        return this.request<{
            podcast?: { id: string; title: string; coverUrl: string | null };
            episode: {
                id: string;
                title: string;
                duration: number;
                coverUrl: string | null;
                progress: { currentTime: number; progress: number; isFinished: boolean; lastPlayedAt: Date } | null;
            } | null;
        }>(`/podcasts/${podcastId}/episodes/${episodeId}/next`);
    }

    async updatePodcastEpisodeProgress(
        podcastId: string,
        episodeId: string,
        currentTime: number,
        duration: number | undefined,
        isFinished: boolean = false
    ) {
        return this.request<ApiData>(
            `/podcasts/${podcastId}/episodes/${episodeId}/progress`,
            {
                method: "POST",
                body: JSON.stringify({ currentTime, duration, isFinished }),
                // Sent as the page closes too (pagehide): kept alive, the browser finishes it instead of cancelling it.
                keepalive: true,
            }
        );
    }

    async getPodcastCategories() {
        return this.request<PodcastCategory[]>("/podcasts/categories");
    }

    /** Apple's chart for a category, or the overall chart for `null`. */
    /** `background`: nobody is waiting on it yet, so the server asks Apple for it after the requests people are. */
    async getPodcastChart(category: number | null, limit = 24, offset = 0, background = false) {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (category !== null) params.set("category", String(category));
        if (background) params.set("background", "true");
        return this.request<DiscoveryPodcast[]>(`/podcasts/charts?${params}`);
    }

    async getPodcastsForYou() {
        return this.request<ForYouRow[]>("/podcasts/for-you");
    }

    async getPodcastListening() {
        return this.request<{ inProgress: ListeningRow[]; newEpisodes: ListeningRow[] }>("/podcasts/listening");
    }

    getPodcastSnippetUrl(itunesId: string): string {
        return this.tokenizedUrl(`/api/podcasts/preview/${encodeURIComponent(itunesId)}/snippet`);
    }

    async getSimilarPodcasts(podcastId: string) {
        return this.request<DiscoveryPodcast[]>(`/podcasts/${podcastId}/similar`);
    }

    /** Similar shows for a show not followed yet, by its Apple id. */
    async getPreviewSimilarPodcasts(itunesId: string) {
        return this.request<DiscoveryPodcast[]>(`/podcasts/preview/${itunesId}/similar`);
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

    async refreshPodcast(podcastId: string) {
        return this.request<{ success: boolean; newEpisodesCount: number; totalEpisodes: number; message: string }>(
            `/podcasts/${podcastId}/refresh`
        );
    }

    async refreshAllPodcasts() {
        return this.request<{ queued: number; total: number; message: string }>(
            "/podcasts/refresh-all",
            { method: "POST" }
        );
    }

    // Playback State (cross-device sync)
    /** How many tracks the server will keep, as an admin has it set. */
    async getQueueLimit() {
        return this.request<{ maxQueueLength: number }>("/playback-state/limit");
    }

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

    /** Play, pause, seek and up-next changes for the public live trip; sent only when `liveReporting` is on. */
    async reportLive(report: {
        status: "playing" | "paused" | "stopped";
        trackId: string;
        position: number;
        duration: number;
        queue: { trackId: string; duration: number }[];
    }) {
        return this.request<{ ok: boolean }>("/playback-state/live", {
            method: "POST",
            body: JSON.stringify(report),
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
            | "podcasts"
            | "episodes" = "all",
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
        return this.request<Mix[]>(`/mixes?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    }

    async getMix(id: string) {
        return this.request<ApiData>(`/mixes/${id}?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    }

    async refreshMixes() {
        return this.request<{ message: string; mixes: ApiData[] }>(
            `/mixes/refresh?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
            {
                method: "POST",
            }
        );
    }

    async saveMixAsPlaylist(mixId: string, customName?: string) {
        return this.request<{ id: string; name: string; trackCount: number }>(
            `/mixes/${mixId}/save?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
            {
                method: "POST",
                body: customName
                    ? JSON.stringify({ name: customName })
                    : undefined,
            }
        );
    }

    // Release window: the mood-mix question
    async getMoodMixReleaseState() {
        return this.get<MoodMixReleaseState>("/whats-new/mood-mixes");
    }

    // Release window: is a newer server release out?
    async getUpdateStatus() {
        return this.get<UpdateStatus>("/whats-new/update-status");
    }

    async decideMoodMixes(decision: MoodMixDecision) {
        return this.post<{ decision: MoodMixDecision; removed: number }>(
            "/whats-new/mood-mixes/decision",
            { decision }
        );
    }

    async saveMoodMixAsPlaylist(mixId: string) {
        return this.post<{ id: string; name: string; trackCount: number; created: boolean }>(
            "/whats-new/mood-mixes/save",
            { mixId }
        );
    }

    // Mood Bucket System (simplified, pre-computed)
    async getMoodBucketPresets() {
        return this.request<MoodBucketPreset[]>("/mixes/mood/buckets/presets");
    }

    async getMoodBucketMix(mood: MoodType) {
        return this.request<MoodBucketMix>(`/mixes/mood/buckets/${mood}`);
    }

    // Pass the ids that were actually played, so the saved mix is the one the
    // user heard: without them the server draws a fresh selection, which
    // skips the tracks just served and never matches.
    async saveMoodBucketMix(mood: MoodType, trackIds?: string[]) {
        return this.request<{
            success: boolean;
            mix: MoodBucketMix & { generatedAt: string };
        }>(
            `/mixes/mood/buckets/${mood}/save`,
            {
                method: "POST",
                body: JSON.stringify(trackIds ? { trackIds } : {}),
            }
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
            source: string;
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
                /** Open but blocked behind the fingerprint → recording gate. */
                waiting: number;
                /** Songs whose files are gone: not owed, and not counted in `progress`. */
                waitingMissing: number;
                progress: number;
            };
            audioAnalysis: {
                total: number;
                completed: number;
                pending: number;
                queued: number;
                processing: number;
                failed: number;
                permanentlyFailed: number;
                waitingMissing: number;
                progress: number;
                isBackground: boolean;
            };
            clapEmbeddings: {
                total: number;
                completed: number;
                pending: number;
                processing: number;
                failed: number;
                /** Of `failed`, the ones due another try. */
                retrying: number;
                waitingMissing: number;
                progress: number;
                isBackground: boolean;
            };
            /** AcoustID fingerprints, made on this server for every song. */
            fingerprints: {
                total: number;
                completed: number;
                pending: number;
                processing: number;
                /** Due another try and given up, together. */
                failed: number;
                waitingMissing: number;
                progress: number;
                isBackground: boolean;
            };
            moods: {
                total: number;
                completed: number;
                pending: number;
                progress: number;
                isBackground: boolean;
            };
            similarity: {
                total: number;
                completed: number;
                pending: number;
                progress: number;
                isBackground: boolean;
            };
            coreComplete: boolean;
            isFullyComplete: boolean;
        }>("/enrichment/progress");
    }

    async retryFailedAndBlocked() {
        return this.request<{
            message: string;
            description: string;
            queued: number;
        }>("/enrichment/retry-failed-and-blocked", { method: "POST" });
    }

    async wipeAndRerunEnrichment() {
        return this.request<{ artists: number; tracks: number; vectors: number }>(
            "/enrichment/wipe-and-rerun",
            { method: "POST" },
        );
    }

    /** Re-run the enrichment from one of the six steps; everything that
     * depends on the step is worked out again. */
    async rerunEnrichment(step: EnrichmentRerunStep) {
        return this.request<{ artists: number; tracks: number; vectors: number; message: string }>(
            "/enrichment/rerun",
            { method: "POST", body: JSON.stringify({ step }) },
        );
    }

    async redecideEverything() {
        return this.request<{
            message: string;
            description: string;
            reopened: number;
        }>("/enrichment/re-decide-everything", { method: "POST" });
    }

    // Enrichment control and failure management

    async getEnrichmentState() {
        return this.get<EnrichmentState | null>("/enrichment/status");
    }

    async pauseEnrichment() {
        return this.post<{ message: string; state: EnrichmentState }>(
            "/enrichment/pause",
            {}
        );
    }

    async resumeEnrichment() {
        return this.post<{ message: string; state: EnrichmentState }>(
            "/enrichment/resume",
            {}
        );
    }

    async stopEnrichment() {
        return this.post<{ message: string; state: EnrichmentState }>(
            "/enrichment/stop",
            {}
        );
    }

    async getEnrichmentFailures(params?: {
        entityType?: "artist" | "track" | "audio" | "vibe" | "scan";
        includeSkipped?: boolean;
        includeResolved?: boolean;
        limit?: number;
        offset?: number;
    }) {
        const query = new URLSearchParams();
        if (params?.entityType) query.set("entityType", params.entityType);
        if (params?.includeSkipped) query.set("includeSkipped", "true");
        if (params?.includeResolved) query.set("includeResolved", "true");
        if (params?.limit) query.set("limit", params.limit.toString());
        if (params?.offset) query.set("offset", params.offset.toString());

        const queryString = query.toString();
        return this.get<{ failures: EnrichmentFailure[]; total: number }>(
            `/enrichment/failures${queryString ? `?${queryString}` : ""}`
        );
    }

    async getEnrichmentFailureCounts() {
        return this.get<FailureCounts>("/enrichment/failures/counts");
    }

    async getEnrichmentConcurrency() {
        return this.get<ConcurrencyConfig>("/enrichment/concurrency");
    }

    async setEnrichmentConcurrency(concurrency: number) {
        return this.request<ConcurrencyConfig>("/enrichment/concurrency", {
            method: "PUT",
            body: JSON.stringify({ concurrency }),
        });
    }

    async retryFailedAnalysis() {
        return this.request<{ message: string; reset: number }>("/analysis/retry-failed", {
            method: "POST",
        });
    }

    async getAnalysisWorkers() {
        return this.get<AnalysisWorkersConfig>("/analysis/workers");
    }

    async setAnalysisWorkers(workers: number) {
        return this.request<AnalysisWorkersConfig>("/analysis/workers", {
            method: "PUT",
            body: JSON.stringify({ workers }),
        });
    }

    async getClapWorkers() {
        return this.get<AnalysisWorkersConfig>("/analysis/clap-workers");
    }

    async setClapWorkers(workers: number) {
        return this.request<AnalysisWorkersConfig>("/analysis/clap-workers", {
            method: "PUT",
            body: JSON.stringify({ workers }),
        });
    }

    /** Whether audio analysis and sound vectors run side by side (admin). Off: one after the other. */
    async getAnalysisTogether() {
        return this.get<{ together: boolean }>("/analysis/together");
    }

    async setAnalysisTogether(together: boolean) {
        return this.request<{ together: boolean }>("/analysis/together", {
            method: "PUT",
            body: JSON.stringify({ together }),
        });
    }

    async getGpuStatus() {
        return this.get<GpuRuntimeStatus>("/system-settings/gpu");
    }

    async setGpuEnabled(enabled: boolean) {
        return this.request<GpuRuntimeStatus>("/system-settings/gpu", {
            method: "POST",
            body: JSON.stringify({ enabled }),
        });
    }

    async setGpuAnalysisEnabled(analysis: boolean) {
        return this.request<GpuRuntimeStatus>("/system-settings/gpu", {
            method: "POST",
            body: JSON.stringify({ analysis }),
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
        return this.request<ApiData>(`/enrichment/tracks/${trackId}/metadata`, {
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
    async markNotificationAsRead(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/${id}/read`);
    }

    async clearNotification(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/${id}/clear`);
    }

    async clearAllNotifications(): Promise<{ success: boolean }> {
        return this.post("/notifications/clear-all");
    }

    async createNotification(body: {
        type: "error" | "system";
        title: string;
        message?: string;
        href?: string;
    }): Promise<{ id: string }> {
        return this.post("/notifications", body);
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
    async getVibeSimilarTracks(trackId: string, limit = 20, signal?: AbortSignal) {
        return this.request<{ sourceTrackId: string; tracks: VibeTrack[] }>(
            `/vibe/similar/${trackId}?limit=${limit}`,
            { signal }
        );
    }

    async vibeSearch(query: string, limit = 20) {
        return this.request<{ query: string; tracks: VibeTrack[] }>("/vibe/search", {
            method: "POST",
            body: JSON.stringify({ query, limit }),
        });
    }

    async getVibeMap() {
        // 202 { computing: true } until the similarity step has laid the library out; the caller polls.
        return this.request<{ computing: true } | { tracks: MapTrack[]; trackCount: number }>("/vibe/map");
    }

    async getVibePath(startTrackId: string, endTrackId: string, options?: { length?: number; mode?: "smooth" | "discovery" }) {
        return this.request<{
            startTrack: VibePathTrack;
            endTrack: VibePathTrack;
            path: Array<VibePathTrack>;
            metadata: { totalTracks: number; embeddingDistance: number; averageStepSize: number; mode: string };
        }>("/vibe/path", {
            method: "POST",
            body: JSON.stringify({ startTrackId, endTrackId, ...options }),
        });
    }

    async getVibeAlchemy(add: string[], subtract: string[], limit = 20) {
        return this.request<{ tracks: VibeTrack[] }>("/vibe/alchemy", {
            method: "POST",
            body: JSON.stringify({ add, subtract, limit }),
        });
    }

    async retryFailedDownload(
        id: string
    ): Promise<{ success: boolean; newJobId?: string }> {
        return this.post(`/notifications/downloads/${id}/retry`);
    }

    // Share Links
    async createShareLink(
        entityType: "playlist" | "track" | "album",
        entityId: string
    ): Promise<{ token: string; url: string; existing?: boolean }> {
        return this.request<{ token: string; url: string; existing?: boolean }>("/share", {
            method: "POST",
            body: JSON.stringify({ entityType, entityId }),
        });
    }

    async revokeShareLink(token: string): Promise<{ message: string }> {
        return this.request<{ message: string }>(`/share/${token}`, {
            method: "DELETE",
        });
    }

    // M3U Import (uses raw fetch -- FormData requires browser-set Content-Type)
    async importM3U(
        file: File,
        playlistName: string
    ): Promise<{ playlistId: string; matched: number; unmatched: number; total: number }> {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("playlistName", playlistName);

        const response = await fetch(`${getApiBaseUrl()}/api/spotify/import/m3u`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.getToken()}` },
            body: formData,
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(
                (error as Record<string, string>).error || "M3U import failed"
            );
        }

        return response.json();
    }
    // Corrupt tracks
    async getCorruptTracks() {
        return this.request<{
            count: number;
            tracks: Array<{
                id: string;
                title: string;
                artist: string;
                album: string;
                filePath: string;
            }>;
        }>("/library/corrupt-tracks");
    }

    async clearCorruptTracks() {
        return this.request<{ cleared: number; message: string }>(
            "/library/corrupt-tracks",
            { method: "DELETE" }
        );
    }
}

export const api = new ApiClient();
