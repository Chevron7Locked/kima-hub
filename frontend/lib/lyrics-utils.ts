export interface LyricLine {
    time: number; // milliseconds
    text: string;
}

const TIMESTAMP_RE = /^\[(\d{2}):(\d{2})(?:[.:](\d{2,3}))?\]\s?(.*)/;
const METADATA_RE = /^\[[a-z]{2}:/i;

export function parseLRC(lrc: string): LyricLine[] {
    const lines: LyricLine[] = [];

    for (const raw of lrc.split("\n")) {
        const line = raw.trim();
        if (!line || METADATA_RE.test(line)) continue;

        const match = line.match(TIMESTAMP_RE);
        if (!match) continue;

        const mins = parseInt(match[1], 10);
        const secs = parseInt(match[2], 10);
        let ms = 0;
        if (match[3]) {
            // Handle both centiseconds (2 digits) and milliseconds (3 digits)
            ms = match[3].length === 2
                ? parseInt(match[3], 10) * 10
                : parseInt(match[3], 10);
        }

        const time = mins * 60000 + secs * 1000 + ms;
        const text = match[4];

        if (text.length > 0) {
            lines.push({ time, text });
        }
    }

    lines.sort((a, b) => a.time - b.time);
    return lines;
}
