export interface AudiobookProgress {
    currentTime: number;
    progress: number;
    isFinished: boolean;
    lastPlayedAt: Date;
}

export interface AudiobookSection {
    index: number;
    title: string;
    start: number;
}

export interface AudiobookSeries {
    name: string;
    sequence: string;
}

export interface AudiobookTrack {
    index: number;
    startOffset: number;
    duration: number;
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
    trackCount?: number;
    sections?: AudiobookSection[];
}

export interface AudiobookMetadata {
    narrator: string | null;
    genre: string | null;
    publishedYear: string | null;
    description: string | null;
}
