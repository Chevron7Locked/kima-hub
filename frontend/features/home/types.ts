/**
 * Artist entity from the library
 */
export interface Artist {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string;
    albumCount?: number;
}

/**
 * Item that appears in the "Continue Listening" / "Recently Listened" section
 * Can be an artist, podcast, or audiobook with optional progress tracking
 */
export interface ListenedItem {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string;
    type: 'artist' | 'podcast' | 'audiobook';
    progress?: number;
    author?: string;
}

/**
 * Audiobook entity
 */
export interface Audiobook {
    id: string;
    title: string;
    author?: string;
    coverUrl?: string;
}

/**
 * Programmatic mix (Made For You mixes)
 */
export interface Mix {
    id: string;
    name: string;
    description: string;
    coverUrls: string[];
    trackCount: number;
}

/**
 * Popular artist with listener count from the similarity engine
 */
export interface PopularArtist {
    id?: string;
    name: string;
    image?: string;
    listeners?: number;
}

/**
 * Playlist preview from external sources (Deezer, etc.)
 */
export interface PlaylistPreview {
    id: string;
    source: string;
    type: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}
