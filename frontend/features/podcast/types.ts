interface EpisodeProgress {
    currentTime: number;
    progress: number;
    isFinished: boolean;
    lastPlayedAt: Date;
}

export interface Episode {
    id: string;
    title: string;
    description?: string;
    duration: number;
    publishedAt: string;
    episodeNumber?: number;
    season?: number;
    imageUrl?: string;
    progress?: EpisodeProgress;
}

/** Apple's podcast category; a sub-category names its parent. */
export interface PodcastCategory {
    id: number;
    name: string;
    parentId: number | null;
}

export interface CategoryRef {
    id: number;
    name: string;
}

/** A show from Apple's charts, not yet followed; `id` is its Apple id. */
export interface DiscoveryPodcast {
    id: string;
    itunesId: string;
    title: string;
    author: string;
    description: string;
    coverUrl: string | null;
    genres: string[];
    chartRank: number | null;
}

export interface ForYouRow {
    category: PodcastCategory;
    because: string[];
    podcasts: DiscoveryPodcast[];
}

/** One episode in "continue listening" or "new from your shows", with the show it belongs to. */
export interface ListeningRow {
    podcast: { id: string; title: string; coverUrl: string | null };
    episode: Episode & { coverUrl: string | null };
}

export interface Podcast {
    id: string;
    title: string;
    author: string;
    description?: string;
    coverUrl: string;
    genres?: string[];
    categories?: CategoryRef[];
    itunesId?: string | null;
    feedUrl?: string;
    episodes: Episode[];
    episodeTotal?: number;
}

export interface PodcastPreview {
    title: string;
    author: string;
    description?: string;
    coverUrl: string;
    genres?: string[];
    feedUrl?: string;
    itunesId?: string;
    isSubscribed: boolean;
    subscribedPodcastId?: string;
    episodeCount?: number;
    categories?: CategoryRef[];
    previewEpisodes?: Array<{
        title: string;
        publishedAt: string;
        duration: number;
        description?: string;
    }>;
    /** The show's first episode, playable before following. */
    snippet?: { title: string; duration: number } | null;
}
