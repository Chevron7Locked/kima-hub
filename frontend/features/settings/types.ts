/**
 * Settings Types
 * Centralized type definitions for the settings feature
 */

export interface UserSettings {
    playbackQuality: "original" | "high" | "medium" | "low";
    wifiOnly: boolean;
    offlineEnabled: boolean;
    maxCacheSizeMb: number;
}

export interface SystemSettings {
    // Lidarr
    lidarrEnabled: boolean;
    lidarrUrl: string;
    lidarrApiKey: string;
    lidarrQualityProfileId: number | null;
    lidarrMetadataProfileId: number | null;
    // AI Services
    openaiEnabled: boolean;
    openaiApiKey: string;
    openaiModel: string;
    fanartEnabled: boolean;
    fanartApiKey: string;
    lastfmApiKey: string;
    // Audiobookshelf
    audiobookshelfEnabled: boolean;
    audiobookshelfUrl: string;
    audiobookshelfApiKey: string;
    // Soulseek (direct connection via slsk-client)
    soulseekUsername: string;
    soulseekPassword: string;
    // Spotify (for playlist import)
    spotifyClientId: string;
    spotifyClientSecret: string;
    // Storage
    musicPath: string;
    downloadPath: string;
    // Advanced
    transcodeCacheMaxGb: number;
    maxCacheSizeMb: number;
    autoSync: boolean;
    autoEnrichMetadata: boolean;
    audioAnalyzerWorkers: number;
    soulseekConcurrentDownloads: number;
    // Download Preferences
    downloadSource: "soulseek" | "lidarr";
    primaryFailureFallback: "none" | "lidarr" | "soulseek";
    // Server
    publicUrl: string;
}

export interface ApiKey {
    id: string;
    name: string;
    keyPreview?: string;
    createdAt: string;
    lastUsed?: string | null;
    lastUsedAt?: string | null;
}

