export interface AudiobookProgress {
    currentTime: number;
    progress: number;
    isFinished: boolean;
    lastPlayedAt: Date;
}

export interface AudiobookChapter {
    id: number;
    title: string;
    start: number;
    end: number;
}

export interface AudiobookSeries {
    name: string;
    sequence: string;
}

export interface AudiobookMetaTags {
    tagGenre?: string;
    tagDate?: string;
    tagComment?: string;
    tagAlbum?: string;
}

export interface AudiobookTrack {
    index: number;
    startOffset: number;
    duration: number;
}

export interface AudiobookAudioFile {
    metaTags?: AudiobookMetaTags;
}

export interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string;
    description?: string;
    coverUrl: string | null;
    duration: number;
    libraryId?: string;
    publisher?: string;
    publishedYear?: string;
    genres?: string[];
    series?: AudiobookSeries;
    isbn?: string;
    asin?: string;
    language?: string;
    progress?: AudiobookProgress | null;
    tracks?: AudiobookTrack[];
    chapters?: AudiobookChapter[];
    audioFiles?: AudiobookAudioFile[];
}

export interface AudiobookMetadata {
    narrator: string | null;
    genre: string | null;
    publishedYear: string | null;
    description: string | null;
}
