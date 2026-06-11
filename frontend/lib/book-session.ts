import { api } from "@/lib/api";

export interface BookFile {
    index: number;
    startOffset: number;
    duration: number;
}

export class BookSessionUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BookSessionUnavailableError";
    }
}

function sortedFiles(files: BookFile[]): BookFile[] {
    return [...files].sort((a, b) => a.startOffset - b.startOffset);
}

function affirmedSingleFile(duration: number): BookFile[] {
    return [{ index: 1, startOffset: 0, duration }];
}

export class BookSession {
    readonly bookId: string;
    readonly duration: number;
    readonly files: ReadonlyArray<BookFile>;

    private constructor(bookId: string, duration: number, files: BookFile[]) {
        this.bookId = bookId;
        this.duration = duration;
        this.files = files;
    }

    static async open(book: {
        id: string;
        duration: number;
        tracks?: BookFile[];
        trackCount?: number;
    }): Promise<BookSession> {
        if (book.tracks && book.tracks.length > 0) {
            return new BookSession(
                book.id,
                book.duration,
                sortedFiles(book.tracks)
            );
        }

        if (book.trackCount === 1 || book.trackCount === 0) {
            return new BookSession(
                book.id,
                book.duration,
                affirmedSingleFile(book.duration)
            );
        }

        const detail = await (api.getAudiobook(book.id) as Promise<{
            tracks?: BookFile[];
            trackCount?: number;
            tracksUnavailable?: boolean;
        }>);

        if (detail.tracksUnavailable) {
            throw new BookSessionUnavailableError(
                "Audiobook track map unavailable"
            );
        }

        if (detail.tracks && detail.tracks.length > 0) {
            return new BookSession(
                book.id,
                book.duration,
                sortedFiles(detail.tracks)
            );
        }

        const resolvedCount = detail.trackCount ?? book.trackCount;

        if (resolvedCount === 1 || resolvedCount === 0) {
            return new BookSession(
                book.id,
                book.duration,
                affirmedSingleFile(book.duration)
            );
        }

        throw new BookSessionUnavailableError(
            "Cannot determine audiobook track map: trackCount unknown"
        );
    }

    locate(bookTime: number): { file: BookFile; fileTime: number } {
        const clamped = Math.max(0, Math.min(bookTime, this.duration));
        let best = this.files[0];
        for (const f of this.files) {
            if (f.startOffset <= clamped) {
                best = f;
            } else {
                break;
            }
        }
        const rawFileTime = clamped - best.startOffset;
        const fileTime = Math.max(0, Math.min(rawFileTime, best.duration));
        return { file: best, fileTime };
    }

    absolute(file: BookFile, fileTime: number): number {
        return file.startOffset + fileTime;
    }

    isLastFile(file: BookFile): boolean {
        const last = this.files[this.files.length - 1];
        return last.index === file.index;
    }

    fileByIndex(index: number): BookFile | undefined {
        return this.files.find((f) => f.index === index);
    }
}
