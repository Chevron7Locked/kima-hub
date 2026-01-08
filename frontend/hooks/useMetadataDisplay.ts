/**
 * Hook for computing display values from override/canonical fields
 * Pattern: displayValue = userOverride ?? canonicalValue
 */

interface ArtistDisplayData {
    name: string;
    summary: string | null;
    heroUrl: string | null;
    genres: string[];
    hasUserOverrides: boolean;
    // Original values for tooltip/reset display
    originalName?: string;
    originalSummary?: string | null;
}

interface AlbumDisplayData {
    title: string;
    year: number | null;
    coverUrl: string | null;
    genres: string[];
    hasUserOverrides: boolean;
    // Original values for tooltip/reset display
    originalTitle?: string;
    originalYear?: number | null;
}

interface TrackDisplayData {
    title: string;
    trackNo: number | null;
    hasUserOverrides: boolean;
    // Original value for tooltip/reset display
    originalTitle?: string;
}

/**
 * Compute display data for an artist, merging user overrides with canonical data
 */
export function useArtistDisplayData(artist: any): ArtistDisplayData {
    if (!artist) {
        return {
            name: "Unknown Artist",
            summary: null,
            heroUrl: null,
            genres: [],
            hasUserOverrides: false,
        };
    }

    return {
        name: artist.displayName ?? artist.name ?? "Unknown Artist",
        summary: artist.userSummary ?? artist.summary ?? artist.bio ?? null,
        heroUrl: artist.userHeroUrl ?? artist.heroUrl ?? artist.image ?? null,
        genres: mergeGenres(artist.userGenres, artist.genres ?? artist.tags),
        hasUserOverrides: artist.hasUserOverrides ?? false,
        originalName: artist.displayName ? artist.name : undefined,
        originalSummary: artist.userSummary
            ? artist.summary ?? artist.bio
            : undefined,
    };
}

/**
 * Compute display data for an album, merging user overrides with canonical data
 */
export function useAlbumDisplayData(album: any): AlbumDisplayData {
    if (!album) {
        return {
            title: "Unknown Album",
            year: null,
            coverUrl: null,
            genres: [],
            hasUserOverrides: false,
        };
    }

    return {
        title: album.displayTitle ?? album.title ?? "Unknown Album",
        year: album.displayYear ?? album.year ?? null,
        coverUrl: album.userCoverUrl ?? album.coverUrl ?? null,
        genres: mergeGenres(album.userGenres, album.genres),
        hasUserOverrides: album.hasUserOverrides ?? false,
        originalTitle: album.displayTitle ? album.title : undefined,
        originalYear:
            album.displayYear !== undefined && album.displayYear !== null
                ? album.year
                : undefined,
    };
}

/**
 * Compute display data for a track, merging user overrides with canonical data
 */
export function useTrackDisplayData(track: any): TrackDisplayData {
    if (!track) {
        return {
            title: "Unknown Track",
            trackNo: null,
            hasUserOverrides: false,
        };
    }

    return {
        title: track.displayTitle ?? track.title ?? "Unknown Track",
        trackNo: track.displayTrackNo ?? track.trackNo ?? null,
        hasUserOverrides: track.hasUserOverrides ?? false,
        originalTitle: track.displayTitle ? track.title : undefined,
    };
}

/**
 * Merge user genres with canonical genres (user genres first for priority)
 * Deduplicates the result
 */
function mergeGenres(
    userGenres?: string[],
    canonicalGenres?: string[]
): string[] {
    const user = Array.isArray(userGenres) ? userGenres : [];
    const canonical = Array.isArray(canonicalGenres) ? canonicalGenres : [];

    // Merge with user genres taking precedence, then deduplicate
    return [...new Set([...user, ...canonical])];
}
