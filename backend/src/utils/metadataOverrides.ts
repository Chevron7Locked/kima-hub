/**
 * Metadata Override Utilities
 *
 * Helper functions for working with user metadata overrides.
 * Implements the pattern: display = userOverride ?? canonical
 */

import { Artist, Album, Track } from "@prisma/client";

/**
 * Get display name for an artist
 * User override takes precedence over canonical name
 */
export function getArtistDisplayName(artist: Artist): string {
    return artist.displayName ?? artist.name;
}

/**
 * Get display title for an album
 * User override takes precedence over canonical title
 */
export function getAlbumDisplayTitle(album: Album): string {
    return album.displayTitle ?? album.title;
}

/**
 * Get display year for an album
 * User override takes precedence over canonical year
 */
export function getAlbumDisplayYear(album: Album): number | null {
    return album.displayYear ?? album.year ?? null;
}

/**
 * Get display title for a track
 * User override takes precedence over canonical title
 */
export function getTrackDisplayTitle(track: Track): string {
    return track.displayTitle ?? track.title;
}

/**
 * Get display track number for a track
 * User override takes precedence over canonical track number
 */
export function getTrackDisplayNumber(track: Track): number {
    return track.displayTrackNo ?? track.trackNo;
}

/**
 * Check if an entity has user overrides
 */
export function hasOverrides(entity: Artist | Album | Track): boolean {
    return entity.hasUserOverrides;
}

/**
 * Get merged genres (user + canonical) for functional use in mixes/discovery
 * User-added genres take precedence and are merged with canonical genres
 *
 * CRITICAL: This is used for mix generation, discovery, and genre filtering.
 * User preferences always take precedence over Last.fm-collected data.
 */
export function getMergedGenres(entity: {
    genres?: unknown;
    userGenres?: unknown;
}): string[] {
    const canonical = Array.isArray(entity.genres)
        ? entity.genres
        : typeof entity.genres === "string"
        ? JSON.parse(entity.genres)
        : [];

    const userAdded = Array.isArray(entity.userGenres)
        ? entity.userGenres
        : typeof entity.userGenres === "string"
        ? JSON.parse(entity.userGenres)
        : [];

    // Merge and deduplicate (user genres first for priority)
    const merged = [...new Set([...userAdded, ...canonical])];
    return merged;
}

/**
 * Get effective genres for an artist
 * For use in mix generation, discovery, and genre-based features
 */
export function getArtistEffectiveGenres(artist: Artist): string[] {
    return getMergedGenres(artist);
}

/**
 * Get effective genres for an album
 * For use in mix generation, discovery, and genre-based features
 */
export function getAlbumEffectiveGenres(album: Album): string[] {
    return getMergedGenres(album);
}

/**
 * Get display summary for an artist
 * User override takes precedence over canonical summary
 */
export function getArtistDisplaySummary(artist: Artist): string | null {
    return artist.userSummary ?? artist.summary ?? null;
}

/**
 * Get display hero URL for an artist
 * User override takes precedence over canonical hero URL
 */
export function getArtistDisplayHeroUrl(artist: Artist): string | null {
    return artist.userHeroUrl ?? artist.heroUrl ?? null;
}

/**
 * Get display cover URL for an album
 * User override takes precedence over canonical cover URL
 */
export function getAlbumDisplayCoverUrl(album: Album): string | null {
    return album.userCoverUrl ?? album.coverUrl ?? null;
}
