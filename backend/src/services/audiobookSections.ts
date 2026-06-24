export interface BuildChapter {
    title: string;
    start: number;
    end: number;
}

export interface BuildTrack {
    startOffset: number;
    name?: string;
}

export interface AudioSection {
    index: number;
    title: string;
    start: number;
}

const COVERAGE_MIN = 0.85;

export function resolveMetaTags(
    narrator: string | null,
    genres: string[],
    publishedYear: number | null,
    firstFileMeta: Record<string, string> | null
): { narrator: string | null; genres: string[]; publishedYear: number | null } {
    let resolvedNarrator = narrator;
    if (!resolvedNarrator && firstFileMeta?.tagComment) {
        const m = firstFileMeta.tagComment.match(/(?:Read by|Narrated by):\s*(.+)/i);
        if (m) resolvedNarrator = m[1].trim();
    }
    const resolvedGenres =
        genres.length > 0
            ? genres
            : firstFileMeta?.tagGenre
            ? [firstFileMeta.tagGenre]
            : [];
    const resolvedPublishedYear =
        publishedYear ??
        (firstFileMeta?.tagDate ? parseInt(firstFileMeta.tagDate, 10) || null : null);
    return { narrator: resolvedNarrator, genres: resolvedGenres, publishedYear: resolvedPublishedYear };
}

export function buildSections({
    duration,
    chapters,
    tracks,
}: {
    duration: number;
    chapters: BuildChapter[];
    tracks: BuildTrack[];
}): AudioSection[] {
    if (duration <= 0) return [];

    if (chapters.length > 0) {
        const maxEnd = Math.max(...chapters.map((c) => c.end ?? 0));
        const coverage = maxEnd / duration;
        if (coverage >= COVERAGE_MIN) {
            return [...chapters]
                .sort((a, b) => a.start - b.start)
                .map((c, i) => ({ index: i + 1, title: c.title, start: c.start }));
        }
    }

    if (tracks.length >= 2) {
        return [...tracks]
            .sort((a, b) => a.startOffset - b.startOffset)
            .map((t, i) => {
                const raw = t.name ?? "";
                const title =
                    raw
                        .replace(/\.[^.]+$/, "")
                        .replace(/^[\s\-_.]*\d+[\s\-_.]+/, "")
                        .trim() || `Part ${i + 1}`;
                return { index: i + 1, title, start: t.startOffset };
            });
    }

    return [];
}
