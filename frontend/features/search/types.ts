export type FilterTab = "all" | "library" | "discover" | "soulseek";

export interface Artist {
    id: string;
    name: string;
    heroUrl?: string;
    mbid?: string;
    image?: string;
}

export interface Album {
    id: string;
    title: string;
    coverUrl?: string;
    albumId?: string;
    artist?: {
        name: string;
    };
}

export interface Podcast {
    id: string;
    title: string;
    author?: string;
    imageUrl?: string;
    episodeCount?: number;
}

export interface Episode {
    id: string;
    title: string;
    description?: string | null;
    podcastId: string;
    podcastTitle: string;
    publishedAt: Date | string;
    duration: number;
    audioUrl: string;
}

export interface Audiobook {
    id: string;
    title: string;
    author?: string | null;
    narrator?: string | null;
    series?: string | null;
    description?: string | null;
    coverUrl?: string | null;
    duration?: number | null;
}

export interface LibraryTrack {
    id: string;
    title: string;
    duration: number;
    album: {
        id: string;
        title: string;
        coverUrl?: string | null;
        artist: {
            id: string;
            mbid?: string;
            name: string;
        };
    };
    // Metadata override fields
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
}

export interface SearchResult {
    artists?: Artist[];
    albums?: Album[];
    podcasts?: Podcast[];
    tracks?: LibraryTrack[];
    audiobooks?: Audiobook[];
    episodes?: Episode[];
}

export interface DiscoverResult {
    type: "music" | "podcast";
    id?: string;
    name: string;
    mbid?: string;
    image?: string;
    listeners?: number;
}

export interface AliasInfo {
    original: string;
    canonical: string;
    mbid?: string;
}

export interface SoulseekResult {
    username: string;
    path: string;
    filename: string;
    size: number;
    bitrate: number;
    format: string;
    parsedArtist?: string;
    parsedAlbum?: string;
    parsedTitle?: string;
}

export type SoulseekSortField = "quality" | "bitrate" | "size" | "filename";
export type SoulseekViewMode = "flat" | "grouped";
export type SoulseekFormatFilter = "all" | "flac" | "320" | "256";
