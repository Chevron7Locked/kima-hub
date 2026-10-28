export interface UserSettings {
    playbackQuality: "original" | "high" | "medium" | "low";
    wifiOnly: boolean;
    offlineEnabled: boolean;
    maxCacheSizeMb: number;
    /** True when the user saved an LB scrobble token; the value itself is never returned. */
    hasListenbrainzToken?: boolean;
    /** Whether the public live feed shows what this user is playing. */
    shareLiveListening?: boolean;
    /** True only for the user whose listening the server's public feed shares. */
    liveSharingAvailable?: boolean;
}

export interface SystemSettings {
    // Lidarr
    lidarrEnabled: boolean;
    /// Operator-only by default; on, signed-in members may acquire (never delete).
    allowMemberAcquire: boolean;
    lidarrUrl: string;
    lidarrApiKey: string;
    lidarrQualityProfileId: number | null;
    lidarrMetadataProfileId: number | null;
    lidarrRemoveJunk: boolean;
    // Artwork & fingerprinting
    fanartEnabled: boolean;
    fanartApiKey: string;
    acoustidApiKey: string | null;
    // Audiobookshelf
    audiobookshelfEnabled: boolean;
    audiobookshelfUrl: string;
    audiobookshelfApiKey: string;
    // Soulseek (direct connection via slsk-client)
    soulseekUsername: string;
    soulseekPassword: string;
    // Soulseek backend: "p2p" = built-in client, "slskd" = external slskd REST API
    soulseekMode: "p2p" | "slskd";
    slskdUrl: string | null;
    slskdApiKey: string | null;
    // Storage
    musicPath: string;
    downloadPath: string;
    // Advanced
    transcodeCacheMaxGb: number;
    /** How many tracks the play queue may hold, per user. */
    maxQueueLength: number;
    maxCacheSizeMb: number;
    autoSync: boolean;
    soulseekConcurrentDownloads: number;
    // Download Preferences
    downloadSource: "soulseek" | "lidarr";
    primaryFailureFallback: "none" | "lidarr" | "soulseek";
    // Server
    publicUrl: string;
    updateChecksEnabled: boolean;
    podcastChartCountry: string;
}

export interface ConnectionTestResult {
    success: boolean;
    version?: string;
    error?: string;
}

/**
 * Whether Soulseek can be used: slskd holds its own Soulseek account and needs
 * only its address; Kima's own client needs the account itself. Mirrors the
 * server's utils/soulseekConfigured.ts.
 */
export function soulseekConfigured(settings: Pick<SystemSettings, "soulseekMode" | "slskdUrl" | "soulseekUsername" | "soulseekPassword">): boolean {
    if (settings.soulseekMode === "slskd") return !!settings.slskdUrl?.trim();
    return !!(settings.soulseekUsername?.trim() && settings.soulseekPassword?.trim());
}
